import { INestApplication, RequestMethod } from '@nestjs/common';
import { HTTP_CODE_METADATA, METHOD_METADATA, PATH_METADATA, ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { RouteParamtypes } from '@nestjs/common/enums/route-paramtypes.enum';
import { ModulesContainer } from '@nestjs/core';
import { OpenAPIObject, SwaggerModule } from '@nestjs/swagger';
import { extendZodWithOpenApi, OpenApiGeneratorV3, OpenAPIRegistry, RouteConfig } from '@asteasolutions/zod-to-openapi';
import { z as backendZod } from 'zod';
import type { AnyZodObject, ZodArray, ZodEffects, ZodTypeAny } from 'zod';
import * as shared from '@ageless/shared';
import { API_DOC, DocOptions } from './doc';
import { IS_PUBLIC, REQUIRED_PERMISSION, ANY_SIGNED_IN } from './request-context';
import { ZodValidationPipe } from './zod-validation.pipe';

// Schemas come from @ageless/shared and from the backend (path checks). A test runner may load zod twice for them
// (ESM and CommonJS builds), so both copies get the OpenAPI extension; in production they are the same copy.
const z = shared.z;
extendZodWithOpenApi(z);
extendZodWithOpenApi(backendZod);
const kind = (s: unknown) => (s as { _def?: { typeName?: string } } | undefined)?._def?.typeName;

export interface Route {
  method: 'get' | 'post' | 'patch' | 'put' | 'delete';
  path: string;                       // OpenAPI form: /api/hrms/leave/requests/{publicId}
  controller: string;                 // e.g. hrms/leave
  permission: string | undefined;     // a permission code, '*' (anyone signed in) or undefined (no sign-in)
  status: number;
  body?: ZodTypeAny; query?: ZodTypeAny; params: Record<string, ZodTypeAny>;
  doc?: DocOptions;
}

const METHODS: Partial<Record<RequestMethod, Route['method']>> = {
  [RequestMethod.GET]: 'get', [RequestMethod.POST]: 'post', [RequestMethod.PATCH]: 'patch',
  [RequestMethod.PUT]: 'put', [RequestMethod.DELETE]: 'delete',
};

/** Every route of the running app, read from Nest's own route metadata and our decorators and validation pipes. */
export function routesOf(app: INestApplication, prefix = 'api'): Route[] {
  const routes: Route[] = [];
  for (const module of app.get(ModulesContainer).values()) {
    for (const wrapper of module.controllers.values()) {
      const cls = wrapper.metatype as (new (...a: unknown[]) => unknown) | undefined;
      if (!cls) continue;
      const base = String(Reflect.getMetadata(PATH_METADATA, cls) ?? '');
      for (const name of Object.getOwnPropertyNames(cls.prototype)) {
        const handler = (cls.prototype as Record<string, unknown>)[name];
        if (name === 'constructor' || typeof handler !== 'function') continue;
        const sub = Reflect.getMetadata(PATH_METADATA, handler) as string | undefined;
        const method = METHODS[Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod];
        if (sub === undefined || !method) continue;
        const path = `/${[prefix, base, sub].filter((p) => p && p !== '/').join('/')}`.replace(/\/+/g, '/').replace(/:(\w+)/g, '{$1}');
        const route: Route = {
          method, path, controller: base, params: {},
          permission: Reflect.getMetadata(IS_PUBLIC, handler) ? undefined : (Reflect.getMetadata(REQUIRED_PERMISSION, handler) as string | undefined),
          status: (Reflect.getMetadata(HTTP_CODE_METADATA, handler) as number | undefined) ?? (method === 'post' ? 201 : 200),
          doc: Reflect.getMetadata(API_DOC, handler) as DocOptions | undefined,
        };
        const args = (Reflect.getMetadata(ROUTE_ARGS_METADATA, cls, name) ?? {}) as Record<string, { data?: string; pipes?: unknown[] }>;
        for (const [key, arg] of Object.entries(args)) {
          const schema = arg.pipes?.find((p): p is ZodValidationPipe<unknown> => p instanceof ZodValidationPipe)?.schema as ZodTypeAny | undefined;
          if (!schema) continue;
          const type = Number(key.split(':')[0]);
          if (type === RouteParamtypes.BODY) route.body = schema;
          if (type === RouteParamtypes.QUERY) route.query = schema;
          if (type === RouteParamtypes.PARAM && arg.data) route.params[arg.data] = schema;
        }
        routes.push(route);
      }
    }
  }
  return routes.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
}

/** The object inside refinements (`.refine(...)`), as OpenAPI query parameters need an object. */
function objectOf(schema: ZodTypeAny): AnyZodObject | undefined {
  let s: ZodTypeAny = schema;
  while (kind(s) === 'ZodEffects') s = (s as ZodEffects<ZodTypeAny>).innerType();
  return kind(s) === 'ZodObject' ? (s as AnyZodObject) : undefined;
}

/** The OpenAPI 3 document of the whole API. Request and answer shapes come from @ageless/shared. */
export type OpenApiDocument = ReturnType<OpenApiGeneratorV3['generateDocument']>;

export function buildOpenApi(app: INestApplication): OpenApiDocument {
  const registry = new OpenAPIRegistry();
  registry.registerComponent('securitySchemes', 'bearer', { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' });

  // Shapes exported by @ageless/shared become named components (LeaveRequestView, PersonDetail ...).
  const names = new Map<unknown, string>();
  for (const [name, value] of Object.entries(shared)) if (kind(value) && /^[A-Z]/.test(name) && !names.has(value)) names.set(value, name);
  const registered = new Map<unknown, ZodTypeAny>();
  const named = (schema: ZodTypeAny): ZodTypeAny => {
    if (kind(schema) === 'ZodArray') return z.array(named((schema as ZodArray<ZodTypeAny>).element));
    const name = names.get(schema);
    if (!name) return schema;
    if (!registered.has(schema)) registered.set(schema, registry.register(name, schema));
    return registered.get(schema)!;
  };
  const error = named(shared.ErrorResponse);
  const errorReply = (description: string) => ({ description, content: { 'application/json': { schema: error } } });

  for (const r of routesOf(app)) {
    const doc = r.doc ?? { summary: r.path };
    const who = r.permission === undefined ? 'No sign-in.' : r.permission === ANY_SIGNED_IN ? 'Anyone signed in.' : `Permission \`${r.permission}\` (the scope own / team / all is checked against the record).`;
    const config: RouteConfig = {
      method: r.method, path: r.path, tags: [r.controller], summary: doc.summary,
      description: [doc.description, who, doc.resend ? 'Sending the same `publicId` again answers 200 with the stored record.' : undefined,
        doc.csv ? 'Add `format=csv` to download the same report as CSV.' : undefined].filter(Boolean).join('\n\n'),
      security: r.permission === undefined ? [] : [{ bearer: [] }],
      request: {},
      responses: {},
    };
    if (Object.keys(r.params).length) config.request!.params = z.object(r.params);
    const query = r.query && objectOf(r.query);
    if (query) config.request!.query = query;
    if (r.body) {
      const body = objectOf(r.body);
      config.request!.body = doc.multipart && body
        ? { content: { 'multipart/form-data': { schema: body.extend({ [doc.multipart]: z.string().openapi({ type: 'string', format: 'binary' }).optional() }) } } }
        : { content: { 'application/json': { schema: named(r.body) } } };
    } else if (doc.multipart) {
      config.request!.body = { content: { 'multipart/form-data': { schema: z.object({ [doc.multipart]: z.string().openapi({ type: 'string', format: 'binary' }) }) } } };
    }

    const content: Record<string, { schema: ZodTypeAny | { type: 'string'; format: 'binary' } }> = {};
    if (doc.response) content['application/json'] = { schema: named(doc.response) };
    if (doc.file) for (const t of ['application/pdf', 'image/jpeg', 'image/png']) content[t] = { schema: { type: 'string', format: 'binary' } };
    if (doc.csv) content['text/csv'] = { schema: { type: 'string', format: 'binary' } };
    config.responses[r.status] = { description: r.status === 204 ? 'Done (no body)' : 'Success', ...(Object.keys(content).length ? { content } : {}) };
    if (doc.resend && r.status === 201) config.responses[200] = { description: 'Sent again: the stored record', content: { 'application/json': { schema: named(doc.response!) } } };
    if (r.body || r.query || Object.keys(r.params).length) config.responses[400] = errorReply('VALIDATION or a rule of the request');
    if (r.permission !== undefined) {
      config.responses[401] = errorReply('AUTH_MISSING, AUTH_INVALID or AUTH_EXPIRED');
      config.responses[403] = errorReply('FORBIDDEN or a rule such as HRMS_SELF_APPROVAL');
    }
    if (Object.keys(r.params).length) config.responses[404] = errorReply('Not found');
    if (r.method !== 'get') config.responses[409] = errorReply('Conflicts with the stored state (e.g. HRMS_MONTH_LOCKED, HRMS_LEAVE_OVERLAP)');
    registry.registerPath(config);
  }

  return new OpenApiGeneratorV3(registry.definitions).generateDocument({
    openapi: '3.0.3',
    info: {
      title: 'Ageless platform API', version: '0.1.0',
      description: 'Every call except sign-in needs `Authorization: Bearer <token>` from `POST /api/auth/login`. '
        + 'Records are identified by `publicId`. Money is integer paise; times are UTC; work dates are IST. '
        + 'Errors are `{ code, message, details? }`.',
    },
  });
}

/**
 * Serves the API docs: the Swagger page at /api/docs and the raw spec at /api/docs.json (no sign-in needed to read
 * them; trying a call needs a token — "Authorize" with the token from POST /api/auth/login). API_DOCS=off hides both.
 */
export function serveApiDocs(app: INestApplication): void {
  if (process.env.API_DOCS === 'off') return;
  SwaggerModule.setup('api/docs', app, buildOpenApi(app) as unknown as OpenAPIObject, {
    jsonDocumentUrl: 'api/docs.json',
    swaggerOptions: { persistAuthorization: true, docExpansion: 'none', tagsSorter: 'alpha' },
  });
}
