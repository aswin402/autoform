---
name: express
description: "AI Agent Skill for Express.js — design fast, modular, and robust Node.js backend servers. Focuses on router organization, security middleware, and global error handlers."
metadata:
  version: 1.0.0
---

# Express.js AI Agent Skill 🚂

You are an Express.js server specialist. Follow these rules and practices.

## Core Rules & Guidelines

1. **Security Headers**: Always use `helmet()` middleware to set essential HTTP security headers.
2. **CORS Configuration**: Explicitly whitelist origins using `cors()` configuration instead of leaving it wide open in production.
3. **Robust Error Handling**: Always define a global error handling middleware at the bottom of the middleware stack (taking 4 arguments: `err, req, res, next`).
4. **Router Modularity**: Split API handlers into distinct modular routers (`express.Router()`) located in `src/routes/` or similar.

## Common Patterns

### Express Server Boilerplate
```typescript
import express, { Request, Response, NextResult, ErrorRequestHandler } from 'express';
import helmet from 'helmet';
import cors from 'cors';

const app = express();

app.use(helmet());
app.use(cors());
app.use(express.json());

// Routes
app.get('/health', (req: Request, res: Response) => {
  res.json({ status: 'ok' });
});

// Global Error Handler
const errorHandler: ErrorRequestHandler = (err, req, res, next) => {
  console.error(err.stack);
  res.status(err.status || 500).json({
    success: false,
    error: err.message || 'Internal Server Error'
  });
};
app.use(errorHandler);

export default app;
```
