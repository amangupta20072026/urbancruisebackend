/**
 * ==============================================================================
 * validate({ body?, params?, query? }) — Zod → 400
 * ==============================================================================
 * Zod schemas are the source of truth for request shapes. After validation,
 * `req.body / params / query` are typed via `z.infer<>` — controllers work
 * with the parsed data, never raw.
 *
 * Failure → ValidationError with the Zod issues attached to `details`.
 * ==============================================================================
 */
import type { RequestHandler } from 'express';
import type { ParamsDictionary } from 'express-serve-static-core';
import type { ParsedQs } from 'qs';
import { z } from 'zod';
import { ValidationError } from '../../errors/index.js';

// z.ZodType is the non-deprecated replacement for ZodTypeAny in Zod 4.
type AnySchema = z.ZodType;

type Schemas = {
  body?: AnySchema;
  params?: AnySchema;
  query?: AnySchema;
};

export function validate(schemas: Schemas): RequestHandler {
  return (req, _res, next) => {
    if (schemas.body) {
      const r = schemas.body.safeParse(req.body);
      if (!r.success)
        throw new ValidationError('Invalid request body.', r.error.issues, 'VALIDATION_BODY');
      req.body = r.data;
    }
    if (schemas.params) {
      const r = schemas.params.safeParse(req.params);
      if (!r.success)
        throw new ValidationError('Invalid path parameters.', r.error.issues, 'VALIDATION_PARAMS');
      // Express types req.params as ParamsDictionary (Record<string,string>).
      // The Zod-parsed shape is the source of truth — cast at the boundary.
      req.params = r.data as ParamsDictionary;
    }
    if (schemas.query) {
      const r = schemas.query.safeParse(req.query);
      if (!r.success)
        throw new ValidationError('Invalid query string.', r.error.issues, 'VALIDATION_QUERY');
      // Express 5's req.query is a getter-only ParsedQs — write back via defineProperty.
      Object.defineProperty(req, 'query', {
        value: r.data as ParsedQs,
        writable: true,
        configurable: true,
      });
    }
    next();
  };
}
