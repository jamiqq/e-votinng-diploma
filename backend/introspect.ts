// Quick introspection of @aztec/bb.js 0.82.x API surface.
// Run with: npm run introspect
import * as bb from '@aztec/bb.js';

console.log('=== Top-level exports ===');
console.log(Object.keys(bb).join('\n'));

const { Barretenberg, BarretenbergSync, Fr } = bb as any;

if (Fr) {
  console.log('\n=== Fr static methods ===');
  console.log(Object.getOwnPropertyNames(Fr).filter(n => n !== 'length' && n !== 'name'));
  const f = new Fr(3n);
  console.log('\n=== Fr instance (new Fr(3n)) ===');
  console.log(Object.getOwnPropertyNames(Object.getPrototypeOf(f)).filter(n => n !== 'constructor'));
  console.log('  .toBigInt():', typeof f.toBigInt === 'function' ? f.toBigInt() : 'N/A');
  console.log('  .toString():', typeof f.toString === 'function' ? f.toString() : 'N/A');
}

if (BarretenbergSync) {
  console.log('\n=== BarretenbergSync static methods ===');
  console.log(Object.getOwnPropertyNames(BarretenbergSync).filter(n => n !== 'length' && n !== 'name' && n !== 'prototype'));

  console.log('\nInitializing BarretenbergSync...');
  let bbSync: any;
  try {
    bbSync = await BarretenbergSync.initSingleton();
    console.log('initSingleton() OK');
  } catch (e: any) {
    console.log('initSingleton() failed:', e.message);
    try {
      bbSync = await BarretenbergSync.new();
      console.log('new() OK');
    } catch (e2: any) {
      console.log('new() also failed:', e2.message);
    }
  }

  if (bbSync) {
    const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(bbSync)).filter(n => n !== 'constructor');
    console.log('\n=== BarretenbergSync instance methods ===');
    console.log(methods.filter(m => /pedersen|hash/i.test(m)).join('\n') || '(none matching pedersen/hash)');
    console.log('\nAll methods:');
    console.log(methods.join('\n'));

    // Try pedersenHash
    if (typeof bbSync.pedersenHash === 'function') {
      console.log('\n--- Testing pedersenHash([Fr(3n)], 0) ---');
      try {
        const r = bbSync.pedersenHash([new Fr(3n)], 0);
        console.log('Result type:', typeof r, r?.constructor?.name);
        console.log('Result:', r?.toString?.(), '|', r?.toBigInt?.());
      } catch (e: any) {
        console.log('Error:', e.message);
      }
    }
  }
}

if (Barretenberg) {
  console.log('\n=== Barretenberg static methods ===');
  console.log(Object.getOwnPropertyNames(Barretenberg).filter(n => n !== 'length' && n !== 'name' && n !== 'prototype'));
}
