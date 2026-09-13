import { app, initialize } from '../src/app.js';

export default async function handler(req, res) {
  try {
    await initialize();
  } catch (err) {
    console.error('Initialization failed:', err);
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ message: 'Service initialization failed' }));
    return;
  }
  app(req, res);
}
