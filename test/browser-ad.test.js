// Sponsored links go through ad-redirect hosts the VPN's DNS blocks; Lumen's browser opens the
// destination carried in the link instead of stopping on an error page.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { adDestination } from '../server/features/browser.js';

describe('browser: blocked ad redirects', () => {
  test('finds the destination in DoubleClick, Google Ads and DoubleClick Search links', () => {
    assert.equal(
      adDestination('https://ad.doubleclick.net/ddm/trackclk/N1.2;dc_trk_aid=5;dc_rdid=;tfua=;dc_tdv=1?https://acrobat.adobe.com/link/x?sdid=A&gclid=B'),
      'https://acrobat.adobe.com/link/x?sdid=A&gclid=B');
    assert.equal(adDestination('https://www.googleadservices.com/pagead/aclk?sa=L&adurl=https%3A%2F%2Fshop.example.com%2Fp%3Fa%3D1'), 'https://shop.example.com/p?a=1');
    assert.equal(adDestination('https://clickserve.dartsearch.net/link/click?lid=1&ds_dest_url=https://site.example/x'), 'https://site.example/x');
  });

  test('leaves other links alone, and never sends you to another ad host or to this PC', () => {
    assert.equal(adDestination('https://example.com/?url=https://other.example'), null);
    assert.equal(adDestination('https://ad.doubleclick.net/ddm/clk/1'), null);
    assert.equal(adDestination('https://ad.doubleclick.net/x?https://ad.doubleclick.net/y'), null);
    assert.equal(adDestination('https://ad.doubleclick.net/x?http://127.0.0.1:8790/'), null);
    assert.equal(adDestination('not a url'), null);
  });
});
