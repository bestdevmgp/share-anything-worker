export interface Env {
  ALLOWED_ORIGIN: string;
  R2_BUCKET: R2Bucket;
  // Shared secret with the backend. When set, every write must carry a valid
  // backend-issued signature over its storage key. Empty = signing disabled.
  UPLOAD_SIGNING_SECRET?: string;
}

interface MultipartCreateBody {
  storageKey?: string;
  contentType?: string;
  signature?: string;
}

interface MultipartCompleteBody {
  storageKey?: string;
  uploadId?: string;
  parts?: { partNumber: number; etag: string }[];
  signature?: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';
    const corsHeaders: Record<string, string> = {
      'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN,
      'Access-Control-Allow-Methods': 'PUT, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Storage-Key, X-Upload-Id, X-Part-Number, X-Upload-Signature',
      'Access-Control-Expose-Headers': 'ETag',
      'Access-Control-Max-Age': '86400',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    // Health check for uptime monitoring (no origin gating, no R2 access).
    // Handle HEAD as well as GET: UptimeRobot (and most monitors) probe with HEAD.
    if (url.pathname === '/health' && (request.method === 'GET' || request.method === 'HEAD')) {
      return new Response(request.method === 'HEAD' ? null : 'OK', { status: 200, headers: corsHeaders });
    }

    if (origin && origin !== env.ALLOWED_ORIGIN) {
      return new Response('Forbidden', { status: 403 });
    }

    try {
      if (url.pathname === '/upload' && request.method === 'PUT') {
        return await handleDirectUpload(request, env, corsHeaders);
      }
      if (url.pathname === '/multipart/create' && request.method === 'POST') {
        return await handleCreateMultipart(request, env, corsHeaders);
      }
      if (url.pathname === '/multipart/upload-part' && request.method === 'PUT') {
        return await handleUploadPart(request, env, corsHeaders);
      }
      if (url.pathname === '/multipart/complete' && request.method === 'POST') {
        return await handleCompleteMultipart(request, env, corsHeaders);
      }
      return new Response('Not Found', { status: 404, headers: corsHeaders });
    } catch (error) {
      console.error('Worker error:', error);
      return new Response(JSON.stringify({ error: 'Internal Server Error' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
  },
};

async function handleDirectUpload(
  request: Request,
  env: Env,
  corsHeaders: Record<string, string>
): Promise<Response> {
  const storageKey = request.headers.get('X-Storage-Key');
  if (!storageKey) {
    return new Response(JSON.stringify({ error: 'Missing X-Storage-Key header' }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const signatureError = await requireSignature(
    env,
    storageKey,
    request.headers.get('X-Upload-Signature'),
    corsHeaders
  );
  if (signatureError) return signatureError;

  const contentType = request.headers.get('Content-Type') || 'application/octet-stream';
  const result = await env.R2_BUCKET.put(storageKey, request.body, {
    httpMetadata: { contentType },
  });
  if (!result) {
    return new Response(JSON.stringify({ error: 'Upload failed' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  return new Response(JSON.stringify({ success: true, etag: result.etag, key: storageKey }), {
    status: 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json', ETag: result.etag },
  });
}

async function handleCreateMultipart(
  request: Request,
  env: Env,
  corsHeaders: Record<string, string>
): Promise<Response> {
  const body = await request.json<MultipartCreateBody>();
  const { storageKey, contentType } = body;
  if (!storageKey) {
    return new Response(JSON.stringify({ error: 'Missing storageKey' }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const signatureError = await requireSignature(env, storageKey, body.signature ?? null, corsHeaders);
  if (signatureError) return signatureError;

  const multipartUpload = await env.R2_BUCKET.createMultipartUpload(storageKey, {
    httpMetadata: { contentType: contentType || 'application/octet-stream' },
  });

  return new Response(
    JSON.stringify({ uploadId: multipartUpload.uploadId, key: multipartUpload.key }),
    { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
  );
}

async function handleUploadPart(
  request: Request,
  env: Env,
  corsHeaders: Record<string, string>
): Promise<Response> {
  const storageKey = request.headers.get('X-Storage-Key');
  const uploadId = request.headers.get('X-Upload-Id');
  const partNumberStr = request.headers.get('X-Part-Number');
  if (!storageKey || !uploadId || !partNumberStr || !request.body) {
    return new Response(JSON.stringify({ error: 'Missing required headers' }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const signatureError = await requireSignature(
    env,
    storageKey,
    request.headers.get('X-Upload-Signature'),
    corsHeaders
  );
  if (signatureError) return signatureError;

  const partNumber = parseInt(partNumberStr, 10);
  const multipartUpload = env.R2_BUCKET.resumeMultipartUpload(storageKey, uploadId);
  const uploadedPart = await multipartUpload.uploadPart(partNumber, request.body);

  return new Response(
    JSON.stringify({ partNumber: uploadedPart.partNumber, etag: uploadedPart.etag }),
    {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json', ETag: uploadedPart.etag },
    }
  );
}

async function handleCompleteMultipart(
  request: Request,
  env: Env,
  corsHeaders: Record<string, string>
): Promise<Response> {
  const body = await request.json<MultipartCompleteBody>();
  const { storageKey, uploadId, parts } = body;
  if (!storageKey || !uploadId || !parts) {
    return new Response(JSON.stringify({ error: 'Missing required fields' }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const signatureError = await requireSignature(env, storageKey, body.signature ?? null, corsHeaders);
  if (signatureError) return signatureError;

  const multipartUpload = env.R2_BUCKET.resumeMultipartUpload(storageKey, uploadId);
  const uploadedParts = parts.map((p) => ({ partNumber: p.partNumber, etag: p.etag }));
  const result = await multipartUpload.complete(uploadedParts);

  return new Response(
    JSON.stringify({ success: true, etag: result.etag, key: storageKey }),
    { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
  );
}

// Returns a 403 Response when signing is enabled and the signature is missing
// or invalid; returns null (proceed) otherwise. When no secret is configured,
// signing is disabled and all uploads are allowed (matches pre-rollout state).
async function requireSignature(
  env: Env,
  storageKey: string,
  signature: string | null,
  corsHeaders: Record<string, string>
): Promise<Response | null> {
  const secret = env.UPLOAD_SIGNING_SECRET;
  if (!secret) return null;
  if (await verifyUploadSignature(secret, storageKey, signature)) return null;
  return new Response(JSON.stringify({ error: 'Invalid or missing upload signature' }), {
    status: 403,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

// Verifies `<exp>.<hmac>` where hmac = HMAC-SHA256(secret, "<storageKey>:<exp>").
async function verifyUploadSignature(
  secret: string,
  storageKey: string,
  signature: string | null
): Promise<boolean> {
  if (!signature) return false;
  const dot = signature.indexOf('.');
  if (dot <= 0) return false;
  const exp = signature.slice(0, dot);
  const provided = signature.slice(dot + 1);
  const expSecs = Number(exp);
  if (!Number.isFinite(expSecs) || expSecs < Math.floor(Date.now() / 1000)) return false;

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${storageKey}:${exp}`));
  const expected = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return timingSafeEqual(expected, provided);
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
