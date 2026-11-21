#!/usr/bin/env node
/**
 * Hermetic checks for the ARM translation image resolution.
 *
 * Runs no emulator and touches no network: it only pins the image names and
 * the resolveSystemImage() precedence that provisioning and AVD creation use.
 */
import assert from 'node:assert/strict';

import {
  ARM_TRANSLATION_SYSTEM_IMAGE,
  DEFAULT_SYSTEM_IMAGE,
  resolveSystemImage,
} from '../lib/setup.js';

let checks = 0;
function ok(condition, message) {
  checks += 1;
  assert.ok(condition, message);
}
function eq(actual, expected, message) {
  checks += 1;
  assert.deepEqual(actual, expected, message);
}

const SYSTEM_IMAGE_RE = /^system-images;[^;\s]+;[^;\s]+;[^;\s]+$/;

console.log('arm-translation: image names');
ok(SYSTEM_IMAGE_RE.test(ARM_TRANSLATION_SYSTEM_IMAGE), 'ARM image is a valid system image id');
ok(ARM_TRANSLATION_SYSTEM_IMAGE.endsWith('google_apis;x86_64') || ARM_TRANSLATION_SYSTEM_IMAGE.endsWith('google_apis;arm64-v8a'),
  'ARM image uses the Google APIs tag with the host ABI');
ok(SYSTEM_IMAGE_RE.test(DEFAULT_SYSTEM_IMAGE), 'default image is a valid system image id');
ok(ARM_TRANSLATION_SYSTEM_IMAGE !== DEFAULT_SYSTEM_IMAGE, 'ARM and default images differ');

console.log('arm-translation: resolveSystemImage precedence');
eq(resolveSystemImage({}), DEFAULT_SYSTEM_IMAGE, 'no options falls back to the default image');
eq(resolveSystemImage({ armTranslation: false }), DEFAULT_SYSTEM_IMAGE, 'armTranslation:false keeps the default image');
eq(resolveSystemImage({ armTranslation: true }), ARM_TRANSLATION_SYSTEM_IMAGE, 'armTranslation:true selects the Google APIs image');
eq(resolveSystemImage({ armTranslation: true, systemImage: 'system-images;android-34;default;x86_64' }),
  'system-images;android-34;default;x86_64', 'an explicit systemImage wins over armTranslation');
eq(resolveSystemImage({ systemImage: '  system-images;android-33;google_apis;x86_64  ' }),
  'system-images;android-33;google_apis;x86_64', 'explicit systemImage is trimmed');
eq(resolveSystemImage({ armTranslation: 'yes' }), DEFAULT_SYSTEM_IMAGE, 'non-boolean armTranslation is ignored');

console.log(`arm-translation: ${checks} checks passed`);
