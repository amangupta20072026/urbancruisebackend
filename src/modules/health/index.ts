/** health module. Mounted at the app root. */
import type { Router } from 'express';
import router from './routes.js';

export default {
  mount(): Router {
    return router;
  },
};
