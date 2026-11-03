/** Module boundaries, checked in CI with `pnpm boundaries` (runs inside backend/, so paths start at src/). */
module.exports = {
  forbidden: [
    {
      name: 'only-facade-or-schema-across-modules',
      comment: 'A module may use another module only through its facade (calls) or schema.ts (foreign keys).',
      severity: 'error',
      from: { path: '^src/modules/([^/]+)/' },
      to: { path: '^src/modules/([^/]+)/', pathNot: ['^src/modules/$1/', '\\.facade\\.ts$', '/schema\\.ts$'] },
    },
    {
      name: 'hrms-submodules-talk-through-services',
      comment: 'Inside HRMS, a sub-module may use another only through its application service or schema.ts.',
      severity: 'error',
      from: { path: '^src/modules/hrms/([^/]+)/' },
      to: { path: '^src/modules/hrms/([^/]+)/', pathNot: ['^src/modules/hrms/$1/', '/application/[^/]+\\.service\\.ts$', '/schema\\.ts$'] },
    },
    {
      name: 'domain-stays-pure',
      comment: 'Domain code has no database, HTTP or framework imports.',
      severity: 'error',
      from: { path: '/domain/' },
      to: { path: ['node_modules/@nestjs', 'node_modules/drizzle-orm', 'node_modules/pg/', '^src/modules/.+/infrastructure/', '^src/modules/.+/api/'] },
    },
  ],
  options: { doNotFollow: { path: 'node_modules' }, tsConfig: { fileName: 'tsconfig.json' } },
};
