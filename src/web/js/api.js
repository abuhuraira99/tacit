const token = document.querySelector('meta[name="tacit-token"]')?.content || '';

export class ApiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

async function request(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'content-type': 'application/json', 'x-tacit-token': token } : { 'x-tacit-token': token },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* empty body */
  }
  if (!res.ok) throw new ApiError((data && data.error) || `Request failed (${res.status})`, res.status, data);
  return data;
}

export const api = {
  get: (p) => request('GET', p),
  post: (p, b = {}) => request('POST', p, b),
};

export function events(onProgress) {
  const src = new EventSource('/api/events');
  src.addEventListener('progress', (e) => onProgress(JSON.parse(e.data)));
  return () => src.close();
}
