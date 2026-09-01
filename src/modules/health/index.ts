/**
 * ==============================================================================
 * health module — public API
 * ==============================================================================
 * The pattern every module follows:
 *   default export = { mount: () => Router }
 * ==============================================================================
 */
import type { Router } from 'express';
import router from './routes.js';

export default {
  mount(): Router {
    return router;
  },
};
