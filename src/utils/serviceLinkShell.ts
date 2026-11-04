import fs from 'fs';
import path from 'path';
import type { NextFunction, Request, RequestHandler, Response } from 'express';

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The hub link /services/:name is a page of the web app, but /services/mcp and /services/sse
 * also match the user-scoped MCP routes (/:user/mcp, /:user/sse) of a user named "services".
 * A browser navigation to those two paths gets the app shell instead. MCP clients never ask
 * for text/html, and every longer path (/services/mcp/<group>) stays with the MCP routes.
 */
export const serviceLinkShellMiddleware = (
  basePath: string,
  getShellDir: () => string | null,
  limiter: RequestHandler = (_req, _res, next) => next(),
): RequestHandler => {
  // Case-insensitive, like the Express routes this stands in front of.
  const pattern = new RegExp(`^${escapeRegExp(basePath)}/services/(mcp|sse)/?$`, 'i');
  return (req: Request, res: Response, next: NextFunction): void => {
    if ((req.method !== 'GET' && req.method !== 'HEAD') || !pattern.test(req.path)) {
      next();
      return;
    }
    // The answer depends on what the client accepts, so a cache must not mix the two.
    res.vary('Accept');
    const accept = String(req.headers.accept || '');
    const shellDir = getShellDir();
    const shell = shellDir ? path.join(shellDir, 'index.html') : null;
    if (!accept.includes('text/html') || accept.includes('text/event-stream') || !shell) {
      next();
      return;
    }
    if (!fs.existsSync(shell)) {
      next();
      return;
    }
    // The same budget as any other page of the app shell; MCP clients never reach it.
    limiter(req, res, () => res.sendFile(shell));
  };
};
