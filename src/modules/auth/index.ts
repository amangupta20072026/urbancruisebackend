/**
 * ==============================================================================
 * auth module — public mount
 * ==============================================================================
 */
import { Router } from 'express';
import routes from './routes.js';

export default {
  mount(): Router {
    return routes;
  },
};
