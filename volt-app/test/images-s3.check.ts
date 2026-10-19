// ============================================================================
//  IMAGE SERVICE against a REAL S3 API (MinIO, LocalStack, moto, or AWS).
//
//  The cloud path end to end with the real AWS SDK: originals in the image
//  store's S3 driver, derivatives in the S3 cache at {prefix}/img/{sig}/...,
//  with the Content-Type and Cache-Control CloudFront serves from S3.
//
//  Skips (passes) when no endpoint is given, so `npm run check` stays offline.
//    IMAGES_S3_TEST_BUCKET=volt-images AWS_ENDPOINT_URL_S3=http://localhost:9000 \
//    S3_FORCE_PATH_STYLE=1 AWS_ACCESS_KEY_ID=volt AWS_SECRET_ACCESS_KEY=voltvoltvolt \
//    npx tsx test/images-s3.check.ts
// ============================================================================
import sharp from 'sharp';
import { S3Client, HeadObjectCommand, CreateBucketCommand } from '@aws-sdk/client-s3';

const BUCKET = process.env.IMAGES_S3_TEST_BUCKET;
if (!BUCKET || !process.env.AWS_ENDPOINT_URL_S3 && !process.env.AWS_ENDPOINT_URL) {
  console.log('PASS skipped: set IMAGES_S3_TEST_BUCKET and AWS_ENDPOINT_URL_S3 to run against S3');
  console.log('\n1 passed, 0 failed');
  process.exit(0);
}
process.env.IMAGE_STORE_DRIVER = 's3';
process.env.IMAGE_S3_BUCKET = BUCKET;
process.env.IMAGE_S3_PREFIX = '';

let pass = 0, fail = 0;
const check = (m: string, got: unknown, want: unknown) =>
  got === want ? (console.log('PASS ' + m), pass++) : (console.log(`FAIL ${m} -- expected [${String(want)}] got [${String(got)}]`), fail++);

async function main() {
  const { imageStore } = await import('../src/services/imageStore');
  const { imageServiceConfig } = await import('../src/config');
  const { ImageService } = await import('../src/services/images/service');
  const { S3DerivativeCache } = await import('../src/services/images/cache');
  const { accountSigningKey, signWithAccountKey } = await import('../src/services/images/signing');

  const region = process.env.AWS_REGION ?? 'ap-southeast-2';
  const s3 = new S3Client({ region, forcePathStyle: process.env.S3_FORCE_PATH_STYLE === '1' });
  await s3.send(new CreateBucketCommand({ Bucket: BUCKET })).catch(() => { /* exists */ });

  const ACC = '00000000-0000-4000-8000-00000000c0de';
  const KEY = `library/${ACC}/posters/s3 test.png`;
  const src = await sharp({ create: { width: 900, height: 600, channels: 3, background: '#2266aa' } }).png().toBuffer();
  await imageStore().put(KEY, src, 'image/png');
  check('S3 store stat sees the original', (await imageStore().stat(KEY))?.size, src.length);
  check('S3 store stat of a missing key is null', await imageStore().stat(`library/${ACC}/nope.png`), null);

  const secret = 's3-check-image-signing-secret-0123456789';
  const cfg = imageServiceConfig({ IMAGE_SIGNING_SECRET: secret } as NodeJS.ProcessEnv);
  const cache = new S3DerivativeCache(BUCKET!, 'img-cache', region);
  const svc = new ImageService(cfg, imageStore(), cache);
  const rest = `300x200,cover,fmt=jpeg,q=70/${KEY}`;
  const sig = signWithAccountKey(accountSigningKey(secret, ACC), rest);
  const r1 = await svc.handle(sig, rest);
  check('first request renders from the S3 original', r1.cache, 'MISS');
  await new Promise((r) => setTimeout(r, 500));
  const head = await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: `img-cache/img/${sig}/${rest}` }));
  check('derivative stored at img-cache/img/{sig}/{rest}', Number(head.ContentLength) > 0, true);
  check('derivative Content-Type for CloudFront', head.ContentType, 'image/jpeg');
  check('derivative Cache-Control for CloudFront', head.CacheControl, 'public, max-age=31536000, immutable');
  const fresh = new ImageService(cfg, imageStore(), new S3DerivativeCache(BUCKET!, 'img-cache', region));
  const r2 = await fresh.handle(sig, rest);
  check('a second task HITs the S3 cache', r2.cache, 'HIT');
  check('cached bytes equal the render', Buffer.compare(r1.body, r2.body), 0);
  const m = await sharp(r2.body).metadata();
  check('cached image is the requested size', `${m.width}x${m.height}`, '300x200');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
