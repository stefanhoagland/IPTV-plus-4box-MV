import type { FastifyInstance, FastifyRequest } from 'fastify';
import { validateCredentials, type AuthService } from '../auth.js';

type IdParams = { Params: { id: string } };

/** Accounts for everyone who watches. Each user gets their own multiview layout. Admin only (see app.ts). */
export async function userRoutes(app: FastifyInstance, opts: { auth: AuthService }) {
  const { auth } = opts;

  app.get('/api/users', async () => ({ users: auth.listUsers() }));

  app.post('/api/users', async (req: FastifyRequest<{ Body: { username?: string; password?: string; isAdmin?: boolean } }>, reply) => {
    const { username, password, isAdmin } = req.body ?? {};
    const problem = validateCredentials(username, password);
    if (problem) return reply.code(400).send({ error: problem });
    if (auth.usernameTaken(username!)) return reply.code(409).send({ error: `"${username}" is already taken` });
    return { user: await auth.createUser(username!, password!, isAdmin === true) };
  });

  app.patch('/api/users/:id', async (req: FastifyRequest<IdParams & { Body: { password?: string; isAdmin?: boolean } }>, reply) => {
    const user = auth.getUser(Number(req.params.id));
    if (!user) return reply.code(404).send({ error: 'User not found' });
    const { password, isAdmin } = req.body ?? {};
    if (password !== undefined) {
      const problem = validateCredentials(user.username, password);
      if (problem) return reply.code(400).send({ error: problem });
    }
    if (isAdmin === false && user.isAdmin) {
      if (user.id === req.user!.id) return reply.code(400).send({ error: "You can't remove your own admin rights" });
      if (auth.adminCount() <= 1) return reply.code(400).send({ error: 'There must be at least one admin' });
    }
    if (typeof isAdmin === 'boolean') auth.setAdmin(user.id, isAdmin);
    if (password !== undefined) await auth.setPassword(user.id, password);
    return { user: auth.getUser(user.id) };
  });

  app.delete('/api/users/:id', async (req: FastifyRequest<IdParams>, reply) => {
    const user = auth.getUser(Number(req.params.id));
    if (!user) return reply.code(404).send({ error: 'User not found' });
    if (user.id === req.user!.id) return reply.code(400).send({ error: "You can't delete your own account" });
    if (user.isAdmin && auth.adminCount() <= 1) return reply.code(400).send({ error: 'There must be at least one admin' });
    auth.deleteUser(user.id);
    return { ok: true };
  });
}
