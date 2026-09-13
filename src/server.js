import { app, initialize } from './app.js';

const PORT = process.env.PORT || 5000;

initialize()
  .then(() => {
    app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
  })
  .catch((err) => {
    console.error('Failed to start server:', err.message);
    process.exit(1);
  });
