import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseM3u } from '../src/m3u.js';

test('parses IPTV-style M3U with attributes, commas in quotes and #EXTGRP', () => {
  const text = [
    '﻿#EXTM3U x-tvg-url="http://epg"',
    '#EXTINF:-1 tvg-id="bbc1.uk" tvg-name="BBC One" tvg-logo="http://logo/bbc1.png" group-title="UK, Main",BBC One HD',
    'http://host/live/1.m3u8',
    '',
    '#EXTINF:-1,Plain Channel',
    '#EXTGRP:Misc',
    '#EXTVLCOPT:http-user-agent=VLC',
    'http://host/live/2.m3u8',
    '#EXTINF:-1 tvg-name="Fallback Name",',
    'http://host/live/3.ts',
    'http://orphan-url-without-extinf',
  ].join('\r\n');

  assert.deepEqual(parseM3u(text), [
    { name: 'BBC One HD', tvgId: 'bbc1.uk', tvgName: 'BBC One', logo: 'http://logo/bbc1.png', group: 'UK, Main', url: 'http://host/live/1.m3u8' },
    { name: 'Plain Channel', tvgId: undefined, tvgName: undefined, logo: undefined, group: 'Misc', url: 'http://host/live/2.m3u8' },
    { name: 'Fallback Name', tvgId: undefined, tvgName: 'Fallback Name', logo: undefined, group: undefined, url: 'http://host/live/3.ts' },
  ]);
});
