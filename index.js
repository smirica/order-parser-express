const express = require('express');
const multer = require('multer');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
let fetchFn = globalThis.fetch;
if (!fetchFn) {
  try {
    fetchFn = require('node-fetch');
  } catch (e) {
    console.warn('fetch not available; Azure OpenAI calls will fail unless a fetch polyfill (node-fetch) is installed');
  }
}

const fs = require('fs');
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;

// Serve static files from the run directory (one level up)
app.use(express.static(path.join(__dirname, '..')));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

function localParseFields(text) {
  const lines = text.split(/\r?\n|\r/).map(l => l.trim()).filter(Boolean);
  const joined = text.replace(/\s+/g, ' ');
  function findLine(regex) {
    for (const ln of lines) {
      const m = ln.match(regex);
      if (m) return m[1] ? m[1].trim() : m[0].trim();
    }
    const m = joined.match(regex);
    return m ? (m[1] || m[0]).trim() : '';
  }
  const projectName = findLine(/project\s*name[:\-\s]*([^,\n]+)/i) || findLine(/project[:\-\s]*([^,\n]+)/i) || '';
  const purchaseOrder = findLine(/(?:purchase\s*order(?:\s*number)?|po\b)[:\-\s#]*([A-Za-z0-9\-\/]+)/i) || '';
  const customerNumber = findLine(/(?:customer\s*(?:number|no|#)|cust(?:omer)?\b)[:\-\s#]*([A-Za-z0-9\-\/]+)/i) || '';
  // improved Dongan detection: try labeled field, else search top-right area (first lines) for a likely order number
  let donganOrder = findLine(/(?:dongan(?:\s*order(?:\s*number)?)?|dongan\s*#)[:\-\s#]*([A-Za-z0-9\-\/]+)/i) || '';

  // try common patterns like "DONGAN Q# 483102" or standalone numeric codes
  if (!donganOrder) {
    const firstLines = lines.slice(0, 10);
    // look for tokens with >=4 digits or patterns with letters+digits
    const candidates = [];
    for (const ln of firstLines) {
      const toks = ln.split(/\s+/).map(t => t.replace(/[^A-Za-z0-9\-#]/g, ''));
      for (const t of toks) {
        if (/\d{4,}/.test(t) || /[A-Za-z]+\d{2,}/.test(t)) candidates.push(t);
      }
      // also check for patterns like Q# 483102 or Q#483102
      const m = ln.match(/Q\s*#?\s*(\d{3,})/i);
      if (m) candidates.push(m[1]);
    }
    if (candidates.length) {
      // prefer the rightmost candidate from the first lines
      donganOrder = candidates[candidates.length - 1];
    }
  }

  let orderDate = findLine(/(?:order\s*date|date\s*of\s*order|date)[:\-\s]*([A-Za-z0-9,\.\-\/ ]{6,40})/i) || '';
  if (!orderDate) {
    const dt = joined.match(/\b(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})\b/);
    if (dt) orderDate = dt[1];
    else {
      const dt2 = joined.match(/\b([A-Za-z]{3,9}\s+\d{1,2},\s*\d{4})\b/);
      if (dt2) orderDate = dt2[1];
    }
  }
  return { ProjectName: projectName, PurchaseOrderNumber: purchaseOrder, CustomerNumber: customerNumber, DonganOrderNumber: donganOrder, OrderDate: orderDate };
}

async function extractTextFromBuffer(fileBuffer, filename) {
  const n = filename.toLowerCase();
  if (n.endsWith('.pdf')) {
    try {
      const data = await pdfParse(fileBuffer);
      return data.text || '';
    } catch (e) {
      console.warn('pdf-parse failed, returning empty text', e && e.message);
      return '';
    }
  }
  if (n.endsWith('.doc') || n.endsWith('.docx')) {
    try {
      const r = await mammoth.extractRawText({ buffer: fileBuffer });
      return r.value || '';
    } catch (e) {
      console.warn('mammoth failed', e && e.message);
      return '';
    }
  }
  // fallback treat as text
  return fileBuffer.toString('utf8');
}

function extractCandidateLines(text) {
  const lines = text.split(/\r?\n|\r/).map(l => l.trim()).filter(Boolean);
  const first = lines.slice(0, 30).join('\n');
  const keywordLines = lines.filter(l => /\b(project|purchase|order|po|dongan|ack|quotation|quote|date)\b/i).slice(0, 50).join('\n');
  // combine but keep size limited
  let combined = first + '\n' + keywordLines;
  if (combined.length > 16000) combined = combined.slice(0, 16000);
  return combined;
}

async function callAzureOpenAI(candidateText, filename) {
  // Requires environment variables: AZURE_OPENAI_ENDPOINT, AZURE_OPENAI_KEY, AZURE_OPENAI_DEPLOYMENT
  const endpoint = process.env.AZURE_OPENAI_ENDPOINT;
  const key = process.env.AZURE_OPENAI_KEY;
  const deployment = process.env.AZURE_OPENAI_DEPLOYMENT; // e.g. "gpt-4o-mini"
  if (!endpoint || !key || !deployment) throw new Error('Azure OpenAI not configured');

  const url = `${endpoint.replace(/\/$/, '')}/openai/deployments/${deployment}/chat/completions?api-version=2023-07-01-preview`;

  const system = `You are a precise JSON extractor. Input will be a small snippet of document text (candidate lines). Extract exactly the fields as JSON with these keys: ProjectName, PurchaseOrderNumber, CustomerNumber, DonganOrderNumber, OrderDate. Use empty string for missing values. Do not add any commentary or extra fields. If a field is clearly a date, return it in MM/DD/YYYY or an unambiguous format.`;

  const example1 = `Example input:\nInvoice header\nDONGAN Q# 483102\nProject: Solar Farm\nPurchase Order: PO-12345\nOrder Date: April 3, 2025`;
  const example1out = `{"ProjectName":"Solar Farm","PurchaseOrderNumber":"PO-12345","CustomerNumber":"","DonganOrderNumber":"483102","OrderDate":"04/03/2025"}`;

  const example2 = `Example input:\nPurchase Order\nCustomer No: CUST-77\nPO # 3419\nDate: 08/06/2025`;
  const example2out = `{"ProjectName":"","PurchaseOrderNumber":"3419","CustomerNumber":"CUST-77","DonganOrderNumber":"","OrderDate":"08/06/2025"}`;

  const body = {
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: `Filename: ${filename}\n\nExamples:\n${example1}\n-->${example1out}\n${example2}\n-->${example2out}\n\nCandidate text:\n${candidateText}\n\nRespond with ONLY the JSON object.` }
    ],
    max_tokens: 1000,
    temperature: 0
  };

  const res = await fetchFn(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'api-key': key },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Azure OpenAI error ${res.status}: ${txt}`);
  }
  const data = await res.json();
  const content = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  if (!content) throw new Error('No content from OpenAI');
  // try to extract JSON
  let parsed = null;
  try {
    parsed = JSON.parse(content.trim());
  } catch (e) {
    const m = content.match(/\{[\s\S]*\}/);
    if (m) {
      try { parsed = JSON.parse(m[0]); } catch (er) { throw new Error('Failed to parse JSON from model response'); }
    } else throw new Error('Model response not JSON');
  }
  return parsed;
}

app.post('/api/parse', upload.array('files', 20), async (req, res) => {
  try {
    const files = req.files || [];
    if (!files.length) return res.status(400).json({ error: 'No files uploaded' });

    const rows = [];
    const useAI = !!(process.env.AZURE_OPENAI_ENDPOINT && process.env.AZURE_OPENAI_KEY && process.env.AZURE_OPENAI_DEPLOYMENT);

    for (const f of files) {
      const text = await extractTextFromBuffer(f.buffer, f.originalname);
      let fields = null;
      if (useAI) {
        try {
                const candidate = extractCandidateLines(text);
                const parsed = await callAzureOpenAI(candidate, f.originalname);
          fields = {
            ProjectName: parsed.ProjectName || parsed.projectName || parsed.Project || '',
            PurchaseOrderNumber: parsed.PurchaseOrderNumber || parsed.purchaseOrder || parsed.PO || '',
            CustomerNumber: parsed.CustomerNumber || parsed.customerNumber || '',
            DonganOrderNumber: parsed.DonganOrderNumber || parsed.donganOrder || parsed.Dongan || '',
            OrderDate: parsed.OrderDate || parsed.orderDate || ''
          };

                // simple validation/post-process: if DonganOrderNumber looks invalid (short or contains words), try local heuristic
                if (!fields.DonganOrderNumber || /[a-zA-Z]{3,}/.test(fields.DonganOrderNumber) && !/\d/.test(fields.DonganOrderNumber)) {
                  const local = localParseFields(text);
                  if (local.DonganOrderNumber) fields.DonganOrderNumber = local.DonganOrderNumber;
                }
              } catch (e) {
                console.warn('Azure OpenAI failed for', f.originalname, e && e.message);
                fields = localParseFields(text);
              }
            } else {
              fields = localParseFields(text);
            }
      rows.push(Object.assign({ Filename: f.originalname }, fields));
    }

    res.json({ rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || String(err) });
  }
});

app.listen(port, () => {
  console.log(`Server listening on http://localhost:${port} — serving files from ${path.join(__dirname, '..')}`);
  console.log('POST files to http://localhost:' + port + '/api/parse (multipart form field name: files)');
});
