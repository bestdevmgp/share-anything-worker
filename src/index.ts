export interface Env {
  ALLOWED_ORIGIN: string;
  R2_BUCKET: R2Bucket;
}

interface MultipartCreateBody {
  storageKey?: string;
  contentType?: string;
}

interface MultipartCompleteBody {
  storageKey?: string;
  uploadId?: string;
  parts?: { partNumber: number; etag: string }[];
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';
    const corsHeaders: Record<string, string> = {
      'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN,
      'Access-Control-Allow-Methods': 'PUT, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Storage-Key, X-Upload-Id, X-Part-Number',
      'Access-Control-Expose-Headers': 'ETag',
      'Access-Control-Max-Age': '86400',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
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

  const multipartUpload = env.R2_BUCKET.resumeMultipartUpload(storageKey, uploadId);
  const uploadedParts = parts.map((p) => ({ partNumber: p.partNumber, etag: p.etag }));
  const result = await multipartUpload.complete(uploadedParts);

  return new Response(
    JSON.stringify({ success: true, etag: result.etag, key: storageKey }),
    { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
  );
}
