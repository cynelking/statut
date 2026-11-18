import { NextRequest, NextResponse } from 'next/server';
import { errorResponse, getRequestUser, listSasPayNetworks } from '@/lib/saspay-server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  try {
    if (!await getRequestUser(request)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
    const { countries, networks } = await listSasPayNetworks();
    return NextResponse.json({ countries, networks });
  } catch (reason) {
    const result = errorResponse(reason);
    console.error('SasPay network list failed', result.status, result.error);
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
}
