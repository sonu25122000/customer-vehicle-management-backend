import { app, initialize } from './app.js';
import { startReportScheduler } from './utils/reportEngine.js';

const PORT = process.env.PORT || 5000;

initialize()
  .then(() => {
    app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
    // Nightly reports. On Vercel (api/index.js) there's no long-running process — vercel.json's cron
    // calls GET /api/reports/cron instead.
    startReportScheduler();
  })
  .catch((err) => {
    console.error('Failed to start server:', err.message);
    process.exit(1);
  });
