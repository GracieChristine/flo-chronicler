require('dotenv').config();

const express            = require('express');
const cors               = require('cors');
const { requireApiKey }  = require('./middleware/auth');
const guidesRouter       = require('./routes/guides');

const PORT = process.env.PORT || 3000;

if (!process.env.API_KEY) {
  console.error('ERROR: API_KEY environment variable is not set. Refusing to start.');
  process.exit(1);
}

const app = express();

app.use(cors());
app.use(express.json({ limit: '50mb' }));

app.get('/health', (req, res) => {
  res.json({ ok: true, service: 'flo-server', version: '0.1.0' });
});

app.use('/guides', requireApiKey, guidesRouter);

app.use((req, res) => {
  res.status(404).json({ error: `Unknown route: ${req.method} ${req.path}` });
});

app.listen(PORT, () => {
  console.log(`flo-server running on port ${PORT}`);
});
