/**
 * Validates body, params and query with Zod and replaces them with the
 * parsed values. Throws ValidationError (400) with the issues.
 */
import type { RequestHandler } from 'express';
import type { ParamsDictionary } from 'express-serve-static-core';
import type { ParsedQs } from 'qs';
import { z } from 'zod';
import { ValidationError } from '../../errors/index.js';

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
      if (!r.success) {
        throw new ValidationError('Invalid request body.', r.error.issues, 'VALIDATION_BODY');
      }
      req.body = r.data;
    }
    if (schemas.params) {
      const r = schemas.params.safeParse(req.params);
      if (!r.success) {
        throw new ValidationError('Invalid path parameters.', r.error.issues, 'VALIDATION_PARAMS');
      }
      req.params = r.data as ParamsDictionary;
    }
    if (schemas.query) {
      const r = schemas.query.safeParse(req.query);
      if (!r.success) {
        throw new ValidationError('Invalid query string.', r.error.issues, 'VALIDATION_QUERY');
      }
      // Express 5's req.query is a getter, so it can't be assigned directly.
      Object.defineProperty(req, 'query', {
        value: r.data as ParsedQs,
        writable: true,
        configurable: true,
      });
    }
    next();
  };
}
