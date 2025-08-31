import Fastify from 'fastify';
import { Server as IOServer } from 'socket.io';
import http from 'http';

const fastify = Fastify();

fastify.get('/health', async () => ({ ok: true }));

const server = http.createServer(fastify as any);
const io = new IOServer(server, { cors: { origin: '*' } });

io.on('connection', (socket) => {
  socket.on('join_room', ({ roomId, userId }) => {
    socket.join(roomId);
    socket.to(roomId).emit('system', `${userId} joined`);
  });
  socket.on('disconnect', () => {});
});

async function bootstrap() {
  try {
    await fastify.ready();
    server.listen(3000, () => {
      console.log('Server running on http://localhost:3000');
    });
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
}

bootstrap();
