import { getAppContext } from '@/server/context';

export const dynamic = 'force-dynamic';

/** RFC 6266 filename for downloads (plain ASCII fallback plus the UTF-8 name). */
function disposition(kind: 'attachment' | 'inline', filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

/** Downloads a generated application document; ?inline=1 shows it in the page (CV preview). */
export async function GET(req: Request, ctx: RouteContext<'/api/documents/[id]'>) {
  const { id } = await ctx.params;
  const { apps } = getAppContext();
  const doc = Number.isInteger(Number(id)) ? apps.documentById(Number(id)) : null;
  if (!doc) return new Response('Not found', { status: 404 });
  let data: Buffer;
  try {
    data = await apps.readDocument(doc);
  } catch {
    return new Response('The file is missing from the data folder.', { status: 404 });
  }
  const inline = new URL(req.url).searchParams.get('inline') === '1';
  const headers: Record<string, string> = {
    'content-type': doc.mime,
    'content-disposition': disposition(inline ? 'inline' : 'attachment', doc.filename),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  };
  // Generated HTML is shown in a sandboxed frame and may not load or run anything.
  if (doc.mime === 'text/html') headers['content-security-policy'] = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox";
  return new Response(new Uint8Array(data), { headers });
}
