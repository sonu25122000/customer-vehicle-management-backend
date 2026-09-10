export function notFound(req, res) {
  res.status(404).json({ message: `Route not found: ${req.method} ${req.originalUrl}` });
}

export function errorHandler(err, req, res, next) {
  console.error(err);

  if (err.code === 11000) {
    const field = Object.keys(err.keyPattern || {})[0] || 'field';
    return res.status(409).json({ message: `A customer with this ${field} already exists` });
  }

  if (err.name === 'ValidationError') {
    const messages = Object.values(err.errors).map((e) => e.message);
    return res.status(400).json({ message: messages.join(', ') });
  }

  if (err.name === 'CastError') {
    return res.status(400).json({ message: 'Invalid identifier supplied' });
  }

  const status = err.status || 500;
  // Unexpected (5xx) errors get a generic message in production so internal details
  // (library errors, file paths, etc.) never reach the client — only intentional 4xx
  // errors carry their own message through.
  const exposeMessage = status < 500 || process.env.NODE_ENV !== 'production';
  res.status(status).json({ message: exposeMessage ? err.message || 'Internal server error' : 'Internal server error' });
}
