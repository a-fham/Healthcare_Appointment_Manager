# Raw SQL via `node-postgres` over an ORM

We decided to write SQL directly (`pg` Pool + parameterized queries + plain
`.sql` migration files run by a ~40-line runner) instead of using Prisma,
Drizzle, or Knex. The submission guidelines say "keep dependencies minimal and
native whenever possible", and every query in this app is short enough that an
ORM would add indirection without adding safety we don't already get from
constraints.

## Why

- The schema's guarantees live in the database (partial unique indexes, FKs,
  enums, `CHECK`s). An ORM would obscure exactly the part being graded.
- Migrations as raw SQL are readable in review: each file is the schema truth.
- `pg` is one small dependency; Prisma pulls an engine binary and a generate
  step; Knex/Drizzle add a query-builder dialect to learn for zero benefit at
  this query count (~25 queries total).
- Parameterized queries through `pool.query(text, values)` are immune to
  injection when used consistently , same guarantee ORMs advertise.

## Considered options

- **Prisma** , best DX for schema-first workflows, but: engine dependency,
  codegen step, and it hides the hand-written constraints we want visible.
- **Knex** , middle ground (migrations + builder), but its builder syntax is
  another language to read in review while adding no capability we need.
- **node-pg-migrate** , good migration tool; rejected only because our runner
  is 40 lines and one less dependency. Revisit if migrations grow complex
  (e.g., need down-migrations , we deliberately ship forward-only).

## Consequences

- No type-safe query results; we validate inputs with zod at the boundary and
  keep queries small and co-located with their feature module.
- Row-to-domain mapping is explicit functions per table (see
  `server/src/db/mappers.js`) , small duplication, high clarity.
