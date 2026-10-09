import type { FastifyInstance, FastifyReply } from 'fastify';
import { SourceService, ValidationError, type SourceInput } from '../sources.js';
import { ChannelService, type ChannelPatch, type ChannelQuery } from '../channels.js';

const MAX_UPLOAD_BYTES = 64 * 1024 * 1024;

function id(params: unknown): number {
  const n = Number((params as { id?: string }).id);
  return Number.isInteger(n) && n > 0 ? n : -1;
}

function handle(reply: FastifyReply, err: unknown) {
  if (err instanceof ValidationError) return reply.code(400).send({ error: err.message });
  throw err;
}

function channelQuery(q: Record<string, string | undefined>): ChannelQuery {
  const num = (s?: string) => (s !== undefined && s !== '' && Number.isFinite(Number(s)) ? Number(s) : undefined);
  return {
    search: q.search || undefined,
    group: q.group,
    sourceId: num(q.sourceId),
    enabled: q.enabled === 'true' ? true : q.enabled === 'false' ? false : undefined,
    offset: num(q.offset),
    limit: num(q.limit),
  };
}

export async function adminRoutes(app: FastifyInstance, opts: { sources: SourceService; channels: ChannelService }) {
  const { sources, channels } = opts;

  app.get('/api/sources', async () => sources.list());

  app.post('/api/sources', { bodyLimit: MAX_UPLOAD_BYTES }, async (req, reply) => {
    try {
      const created = sources.create((req.body ?? {}) as SourceInput);
      // Import straight away so the admin sees channels (or the error) as soon as the form closes.
      return reply.code(201).send(await sources.refresh(created.id));
    } catch (err) {
      return handle(reply, err);
    }
  });

  app.patch('/api/sources/:id', { bodyLimit: MAX_UPLOAD_BYTES }, async (req, reply) => {
    try {
      const body = (req.body ?? {}) as SourceInput;
      const updated = sources.update(id(req.params), body);
      if (!updated) return reply.code(404).send({ error: 'Source not found' });
      const needsReimport = ['url', 'username', 'password', 'fileContent', 'userAgent'].some((k) => k in body);
      return needsReimport ? await sources.refresh(updated.id) : updated;
    } catch (err) {
      return handle(reply, err);
    }
  });

  app.delete('/api/sources/:id', async (req, reply) => {
    if (!sources.delete(id(req.params))) return reply.code(404).send({ error: 'Source not found' });
    return { ok: true };
  });

  app.post('/api/sources/:id/refresh', async (req, reply) => {
    const result = await sources.refresh(id(req.params));
    return result ?? reply.code(404).send({ error: 'Source not found' });
  });

  app.get('/api/channels', async (req) => channels.list(channelQuery(req.query as Record<string, string>)));

  app.get('/api/channels/groups', async (req) => {
    const q = channelQuery(req.query as Record<string, string>);
    return channels.groups(q.sourceId);
  });

  app.patch('/api/channels/:id', async (req, reply) => {
    try {
      const updated = channels.update(id(req.params), (req.body ?? {}) as ChannelPatch);
      return updated ?? reply.code(404).send({ error: 'Channel not found' });
    } catch (err) {
      return handle(reply, err);
    }
  });

  app.post('/api/channels/bulk', async (req, reply) => {
    const body = (req.body ?? {}) as { enabled?: unknown; ids?: unknown; filter?: Record<string, string> };
    if (typeof body.enabled !== 'boolean') return reply.code(400).send({ error: 'enabled must be true or false' });
    if (body.ids !== undefined && !Array.isArray(body.ids)) return reply.code(400).send({ error: 'ids must be a list' });
    const changed = channels.setEnabled(body.enabled, {
      ids: body.ids as number[] | undefined,
      filter: body.filter ? channelQuery(body.filter) : {},
    });
    return { changed };
  });
}
