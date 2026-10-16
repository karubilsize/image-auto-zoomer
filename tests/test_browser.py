"""Real Chromium content-script regressions; no extension policy bypass.
Run: python3 -m unittest discover -s tests -v
Set ZOOMER_SCRIPT to compare a previous content.js.
Requires Python Playwright and /usr/bin/chromium.
"""
import json
import os
from pathlib import Path
import unittest
from urllib.parse import quote
from playwright.sync_api import sync_playwright

SCRIPT = Path(os.environ.get('ZOOMER_SCRIPT', Path(__file__).resolve().parents[1] / 'content.js'))

def image(w, h, **attrs):
    svg = quote(f'<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}"><rect width="100%" height="100%" fill="blue"/></svg>')
    extra = ' '.join(f'{k}="{v}"' for k, v in attrs.items())
    return f'<img src="data:image/svg+xml,{svg}" {extra}>'

BODY = image(80, 80) + '<div style="height:800px"></div>' + image(800, 1200, id='target') + '<div style="height:3000px"></div>'

class BrowserTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.p = sync_playwright().start()
        cls.browser = cls.p.chromium.launch(executable_path='/usr/bin/chromium', headless=True,
                                           args=['--no-sandbox', '--disable-dev-shm-usage'])

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.p.stop()

    def setUp(self):
        self.page = self.browser.new_page(viewport={'width':1280, 'height':720})
        self.errors = []
        self.logs = []
        self.page.on('pageerror', lambda e: self.errors.append(str(e)))
        self.page.on('console', self.record_console)

    def record_console(self, message):
        if message.text.startswith('[Image Auto Zoomer]') and len(message.args) > 1:
            self.logs.append(json.dumps(message.args[1].json_value()))

    def tearDown(self):
        self.page.close()
        self.assertEqual([], self.errors)

    def start(self, body=BODY, setup='', debug=True):
        self.page.route('http://zoomer.test/**', lambda r: r.fulfill(content_type='text/html', body=f'<!doctype html><html><body style="margin:0">{body}</body></html>'))
        self.page.goto('http://zoomer.test/')
        self.page.wait_for_function('Array.from(document.images).every(i => i.complete && i.naturalWidth > 0)')
        if debug:
            self.page.evaluate('localStorage.setItem("imageAutoZoomerDebug", "1")')
        self.page.evaluate(setup or '() => {}')
        self.page.add_script_tag(path=str(SCRIPT))

    def aligned(self, timeout=1800):
        self.page.wait_for_function('Math.abs(document.querySelector("#target").getBoundingClientRect().top) < 3', timeout=timeout)

    def test_largest_zoom_scroll_resize_and_spa(self):
        self.start()
        self.aligned()
        self.page.wait_for_function('Math.abs(target.getBoundingClientRect().height-innerHeight)<2')
        self.page.set_viewport_size({'width':1280,'height':900})
        self.page.wait_for_function('Math.abs(target.getBoundingClientRect().height-innerHeight)<2')
        self.page.wait_for_timeout(2400)
        self.page.evaluate('history.pushState({}, "", "/next"); scrollTo(0,0)')
        self.aligned()

    def test_default_logging_disabled_still_recovers_and_respects_input(self):
        self.start(debug=False)
        self.aligned()
        self.page.wait_for_timeout(400)
        self.page.evaluate('scrollTo(0,0)')
        self.aligned()
        self.page.mouse.wheel(0, 200)
        self.page.wait_for_timeout(400)
        position = self.page.evaluate('scrollY')
        self.page.wait_for_timeout(400)
        self.assertAlmostEqual(position, self.page.evaluate('scrollY'), delta=2)
        self.assertEqual([], self.logs)

    def test_continuous_mutations_do_not_starve_update(self):
        self.start(setup='''() => { window.noise = setInterval(() => {
            document.documentElement.classList.toggle('noise');
        }, 20); }''')
        self.aligned()
        self.page.evaluate('clearInterval(noise)')

    def test_site_restores_top_after_command(self):
        self.start()
        self.aligned()
        self.page.wait_for_timeout(600)
        self.page.evaluate('scrollTo(0,0)')
        self.aligned()
        self.assertTrue(any('scroll-command' in line for line in self.logs))
        self.assertTrue(any('position-changed' in line for line in self.logs))

    def test_user_input_immediately_after_command_is_respected(self):
        self.start(setup='''() => {
          const native = Element.prototype.scrollIntoView;
          Element.prototype.scrollIntoView = function(...args) {
            native.apply(this,args);
            if (!window.interrupted) {
              window.interrupted = true;
              dispatchEvent(new WheelEvent('wheel', {deltaY:200}));
              scrollTo(0,0);
            }
          };
        }''')
        self.page.wait_for_function('window.interrupted === true')
        self.page.wait_for_timeout(900)
        self.assertEqual(0, self.page.evaluate('scrollY'))

    def test_image_arriving_late(self):
        self.start(body='<div style="height:800px"></div><div id="slot"></div><div style="height:3000px"></div>')
        self.page.wait_for_timeout(3100)
        self.page.locator('#slot').evaluate('(el, html) => el.innerHTML=html', image(800,1200,id='target'))
        self.aligned()

    def test_nested_scroll_container(self):
        body = '<div style="height:600px"></div><div id="scroller" style="height:500px;overflow:auto;border:5px solid">' + BODY + '</div><div style="height:2000px"></div>'
        self.start(body=body)
        self.aligned()
        self.assertGreater(self.page.locator('#scroller').evaluate('el => el.scrollTop'), 0)
        self.page.locator('#scroller').evaluate('el => el.scrollTop=0')
        self.aligned()

    def test_css_scroll_offsets_are_not_mistaken_for_displacement(self):
        self.start(setup="() => { target.style.scrollMarginTop='100px'; document.documentElement.style.scrollPaddingTop='40px'; }")
        self.page.wait_for_function('scrollY > 100')
        self.page.wait_for_timeout(700)
        self.assertAlmostEqual(100, self.page.locator('#target').evaluate('el => el.getBoundingClientRect().top'), delta=2)
        commands = [line for line in self.logs if '"event": "scroll-command"' in line]
        self.assertEqual(1, len(commands))

    def test_bfcache_navigation_restarts_completed_session(self):
        self.start()
        self.aligned()
        self.page.wait_for_timeout(5500)
        self.page.evaluate('scrollTo(0,0); dispatchEvent(new PageTransitionEvent("pageshow", {persisted:true}))')
        self.aligned()

    def test_late_pageshow_restoration_after_initial_window(self):
        self.start()
        self.aligned()
        self.page.wait_for_timeout(2600)
        self.page.evaluate('scrollTo(0,0); dispatchEvent(new PageTransitionEvent("pageshow"))')
        self.aligned()
        self.assertTrue(any('lifecycle-rearmed' in line for line in self.logs))

    def test_late_pageshow_does_not_erase_user_intent(self):
        self.start()
        self.aligned()
        self.page.mouse.wheel(0, 250)
        self.page.wait_for_timeout(400)
        self.page.evaluate('scrollTo(0,0); dispatchEvent(new PageTransitionEvent("pageshow"))')
        self.page.wait_for_timeout(700)
        self.assertEqual(0, self.page.evaluate('scrollY'))

    def test_hostile_site_does_not_cause_infinite_corrections(self):
        self.start(setup='''() => {
          window.commandCount=0;
          const native = Element.prototype.scrollIntoView;
          Element.prototype.scrollIntoView = function(...args) {
            commandCount++;
            native.apply(this,args);
            setTimeout(() => scrollTo(0,0), 20);
          };
        }''')
        self.page.wait_for_function('commandCount > 0')
        self.page.wait_for_timeout(2800)
        count = self.page.evaluate('commandCount')
        self.page.wait_for_timeout(600)
        self.assertEqual(count, self.page.evaluate('commandCount'))
        self.assertLess(count, 25)

    def test_key_before_spa_poll_cancels_new_navigation(self):
        self.start()
        self.aligned()
        self.page.wait_for_timeout(2600)
        self.page.evaluate('history.pushState({}, "", "/manual"); scrollTo(0,0)')
        self.page.keyboard.press('ArrowDown')
        self.page.wait_for_timeout(400)
        position = self.page.evaluate('scrollY')
        self.page.wait_for_timeout(900)
        self.assertAlmostEqual(position, self.page.evaluate('scrollY'), delta=2)

if __name__ == '__main__':
    unittest.main()
