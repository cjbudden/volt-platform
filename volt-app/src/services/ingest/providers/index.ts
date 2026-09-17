import type { TransferProvider, Fetch } from './types';
import { AsperaProvider } from './aspera';
import { MasvProvider } from './masv';
import { SigniantProvider } from './signiant';
export * from './types';
export { AsperaProvider, MasvProvider, SigniantProvider };
export { S3AccelProvider } from './s3accel';

export function providersFor(fetchImpl: Fetch = fetch): Record<'aspera' | 'masv' | 'signiant', TransferProvider> {
  return { aspera: new AsperaProvider(fetchImpl), masv: new MasvProvider(fetchImpl), signiant: new SigniantProvider(fetchImpl) };
}
