'use strict';
const fs = require('node:fs');
const { digest } = require('./archive');
function makeClient(env) {
  if (!env.COS_SECRET_ID || !env.COS_SECRET_KEY) throw new Error('COS credentials missing');
  const COS = require('cos-nodejs-sdk-v5');
  return new COS({ SecretId: env.COS_SECRET_ID, SecretKey: env.COS_SECRET_KEY, SecurityToken: env.COS_SECURITY_TOKEN,
    Protocol: 'https:', UploadCheckContentMd5: true, FileParallelLimit: 1, ChunkParallelLimit: 1, MaxPartNumber: 10000, Timeout: 120000 });
}
function call(client, method, args) { return new Promise((resolve, reject) => client[method](args, (err, data) => err ? reject(err) : resolve(data))); }
async function uploadVerified(client, c, file, key) {
  const hash = await digest(file), bytes = fs.statSync(file).size;
  const base = { Bucket: c.bucket, Region: c.region, Key: key };
  await call(client, 'uploadFile', { ...base, FilePath: file, SliceSize: 8 * 1024 * 1024, ChunkSize: 8 * 1024 * 1024,
    Headers: { 'x-cos-meta-sha256': hash }, ContentType: file.endsWith('.gz') ? 'application/gzip' : 'application/json' });
  const head = await call(client, 'headObject', base);
  if (Number(head.headers?.['content-length']) !== bytes || head.headers?.['x-cos-meta-sha256'] !== hash) throw new Error('COS verification mismatch');
  return { key, sha256: hash, bytes, etag: head.ETag || head.headers?.etag || null };
}
module.exports = { makeClient, call, uploadVerified };
