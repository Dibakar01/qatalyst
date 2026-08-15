/**
 * The pixel.
 *
 * One tag on your site, no build step and no configuration:
 *
 *   <script src="https://<tracking-host>/qt.js" async></script>
 *
 * `document.currentScript` lets the script work out its own endpoint, so the
 * tag is identical everywhere it is pasted and there is nothing to keep in
 * step when the host changes.
 *
 * What it does is narrow on purpose. It re-parks the click id from the URL
 * into first-party storage so it outlives the landing page, then reports
 * events. There is no device id, no fingerprint and no hashing — Meta needs
 * those because it is structurally forbidden from knowing who the user is. We
 * mailed these people by name.
 */
export const dynamic = 'force-static'

const PIXEL = `(function () {
  var KEY = 'qt.click'
  var script = document.currentScript
  if (!script) return
  var API = script.src.replace(/\\/qt\\.js.*$/, '/api/collect')

  // The click id arrives once, in the URL, and has to survive every later
  // navigation on the site — signup and payment are rarely the landing page.
  try {
    var id = new URLSearchParams(location.search).get('qt')
    if (id) localStorage.setItem(KEY, id)
  } catch (e) {
    // Private mode, or storage disabled. The visit still counts; only the
    // attribution is lost, and losing it must not break the page.
  }

  window.qt = function (event, extra) {
    var click = null
    try { click = localStorage.getItem(KEY) } catch (e) {}

    var body = {}
    for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) body[k] = extra[k]
    body.event = event
    body.click = click
    body.key = KEY_VALUE

    var payload = JSON.stringify(body)

    // text/plain deliberately. application/json makes this a preflighted
    // cross-origin request, and sendBeacon cannot preflight — the route parses
    // the text itself. sendBeacon also survives the page being closed, which
    // matters when the event is the last thing before a redirect to a payment
    // provider.
    try {
      if (navigator.sendBeacon) {
        navigator.sendBeacon(API, new Blob([payload], { type: 'text/plain' }))
        return
      }
    } catch (e) {}

    // Older browsers, and anything where sendBeacon is refused.
    try {
      var xhr = new XMLHttpRequest()
      xhr.open('POST', API, true)
      xhr.setRequestHeader('Content-Type', 'text/plain')
      xhr.send(payload)
    } catch (e) {}
  }

  // Loading the script is the visit. Needing no call for the commonest event
  // is the entire reason a pixel exists rather than an API.
  window.qt('visited')
})()
`

export function GET() {
  return new Response(PIXEL, {
    headers: {
      'content-type': 'text/javascript; charset=utf-8',
      // An hour: long enough that it is not fetched on every page, short
      // enough that a fix reaches every site the same day.
      'cache-control': 'public, max-age=3600',
    },
  })
}
