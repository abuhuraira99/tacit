import { parentPort } from 'node:worker_threads';
import { parseSessionFile } from './parse-file.js';

parentPort.on('message', async (job) => {
  try {
    const summary = await parseSessionFile(job);
    parentPort.postMessage({ id: job.id, summary });
  } catch (err) {
    parentPort.postMessage({ id: job.id, error: String((err && err.message) || err) });
  }
});
