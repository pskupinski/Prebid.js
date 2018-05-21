const bidFactory =  require('src/bidfactory.js');
const bidManager = require('src/bidmanager.js');
const adapterManager = require('src/adaptermanager');

// From the official Prebid.js consentManager module, with small modifications - https://github.com/prebid/Prebid.js/blob/master/modules/consentManagement.js
/**
 * This function handles interacting with an IAB compliant CMP to obtain the consentObject value of the user.
 * Given the async nature of the CMP's API, we pass in acting success/error callback functions to exit this function
 * based on the appropriate result.
 * @param {function(string)} cmpSuccess acts as a success callback when CMP returns a value; pass along consentObject (string) from CMP
 * @param {function(string)} cmpError acts as an error callback while interacting with CMP; pass along an error message (string)
 * @param {[objects]} adUnits used in the safeframe workflow to know what sizes to include in the $sf.ext.register call
 */
function lookupIabConsent(cmpSuccess, cmpError, params) {
  let cmpCallbacks;

  // check if the CMP is located on the same window level as the prebid code.
  // if it's found, directly call the CMP via it's API and call the cmpSuccess callback.
  // if it's not found, assume the prebid code may be inside an iframe and the CMP code is located in a higher parent window.
  // in this case, use the IAB's iframe locator sample code (which is slightly cutomized) to try to find the CMP and use postMessage() to communicate with the CMP.
  if (typeof window.__cmp === 'function') {
    window.__cmp('getVendorConsents', null, cmpSuccess);
  } else if (inASafeFrame() && typeof window.$sf.ext.cmp === 'function') {
    callCmpWhileInSafeFrame();
  } else {
    callCmpWhileInIframe();
  }

  function inASafeFrame() {
    return !!(window.$sf && window.$sf.ext);
  }

  function callCmpWhileInSafeFrame() {
    function sfCallback(msgName, data) {
      if (msgName === 'cmpReturn') {
        cmpSuccess(data.vendorConsents);
      }
    }

    // find sizes from bids
    let width = 1;
    let height = 1;

    const bids = params.bids || [];
    if (bids && bids.length > 0) {
      width = bids[0].sizes[0][0];
      height = bids[0].sizes[0][1];
    }

    window.$sf.ext.register(width, height, sfCallback);
    window.$sf.ext.cmp('getVendorConsents');
  }

  function callCmpWhileInIframe() {
    /**
     * START OF STOCK CODE FROM IAB 1.1 CMP SPEC
    */

    // find the CMP frame
    let f = window;
    let cmpFrame;
    while (!cmpFrame) {
      try {
        if (f.frames['__cmpLocator']) cmpFrame = f;
      } catch (e) {}
      if (f === window.top) break;
      f = f.parent;
    }

    cmpCallbacks = {};

    /* Setup up a __cmp function to do the postMessage and stash the callback.
      This function behaves (from the caller's perspective identicially to the in-frame __cmp call */
    window.__cmp = function(cmd, arg, callback) {
      if (!cmpFrame) {
        removePostMessageListener();

        let errmsg = 'CMP not found';
        // small customization to properly return error
        return cmpError(errmsg);
      }
      let callId = Math.random() + '';
      let msg = {__cmpCall: {
        command: cmd,
        parameter: arg,
        callId: callId
      }};
      cmpCallbacks[callId] = callback;
      cmpFrame.postMessage(msg, '*');
    }

    /** when we get the return message, call the stashed callback */
    // small customization to remove this eventListener later in module
    window.addEventListener('message', readPostMessageResponse, false);

    /**
     * END OF STOCK CODE FROM IAB 1.1 CMP SPEC
     */

    // call CMP
    window.__cmp('getVendorConsents', null, cmpIframeCallback);
  }

  function readPostMessageResponse(event) {
    // small customization to prevent reading strings from other sources that aren't JSON.stringified
    let json = (typeof event.data === 'string' && includes(event.data, 'cmpReturn')) ? JSON.parse(event.data) : event.data;
    if (json.__cmpReturn) {
      let i = json.__cmpReturn;
      cmpCallbacks[i.callId](i.returnValue, i.success);
      delete cmpCallbacks[i.callId];
    }
  }

  function removePostMessageListener() {
    window.removeEventListener('message', readPostMessageResponse, false);
  }

  function cmpIframeCallback(consentObject) {
    removePostMessageListener();
    cmpSuccess(consentObject);
  }
}

function LockerDomeAdapter() {
  function _gdprWrappedCallBids(params) {
    let submittedBidRequest = false;
    var timer = setTimeout(function () {
      submittedBidRequest = true;
      _callBids(params);
    }, 200);

    lookupIabConsent(function success (gdprConsent) {
      if (submittedBidRequest) return;
      clearTimeout(timer);
      _callBids(params, { gdprConsent: gdprConsent });
    }, function failure () {
      if (submittedBidRequest) return;
      clearTimeout(timer);
      _callBids(params);
    }, params);
  }

  function _callBids (params, bidderRequest) {
    const bids = params.bids || [];
    const adUnitBidRequests = [];

    for (let i = 0; i < bids.length; ++i) {
      const bid = bids[i];
      if (!bid.params.adUnitId) continue;
      adUnitBidRequests.push({
        requestId: bid.bidId,
        adUnitId: bid.params.adUnitId,
        sizes: bid.sizes
      });
    }

    let pageUrl = '';
    let referrer = '';
    try {
      pageUrl = window.top.location.href;
      referrer = window.top.document.referrer;
    } catch (e) {}

    const payload = {
      bidRequests: adUnitBidRequests,
      url: pageUrl,
      referrer: referrer
    };

    if (bidderRequest && bidderRequest.gdprConsent) {
      payload.gdpr = {
        applies: bidderRequest.gdprConsent.gdprApplies,
        consent: bidderRequest.gdprConsent.consentString
      };
    }

    if (!window.XMLHttpRequest) {
      return bail();
    }

    makeBidRequests(payload);

    function makeBidRequests (payload) {
      const payloadString = JSON.stringify(payload);

      const request = new XMLHttpRequest();
      if (request.responseType === undefined) {
        return bail();
      }
      request.onreadystatechange = function () {
        const DONE = 4;
        if (request.readyState === DONE) {
          if (request.status === 200) {
            let response;
            try {
              response = JSON.parse(request.responseText);
            } catch (e) {
              return bail();
            }

            handleResponse(response);
          } else {
            bail();
          }
        }
      };
      request.open("POST", 'https://lockerdome.com/ladbid/prebid', true);
      request.setRequestHeader('Content-Type', 'text/plain');
      request.withCredentials = true;
      request.send(JSON.stringify(payload));
    }


    function bail () {
      handleResponse({ bids: [] });
    }

    function handleResponse (serverResponse) {
      const serverBidResponses = serverResponse && serverResponse.bids || [];
      const bidResponseMap = {};
      const bidById = {};

      for (let i = 0; i < bids.length; ++i) {
        const bid = bids[i];
        bidById[bid.bidId] = bid;
      }

      for (let i = 0; i < serverBidResponses.length; ++i) {
        const serverBidResponse = serverBidResponses[i];
        const bidResponse = bidFactory.createBid(1);
        bidResponse.bidderCode = 'lockerdome';
        bidResponse.requestId = serverBidResponse.requestId;
        bidResponse.cpm = serverBidResponse.cpm;
        bidResponse.width = serverBidResponse.width;
        bidResponse.height = serverBidResponse.height;
        bidResponse.creativeId = serverBidResponse.creativeId;
        bidResponse.currency = serverBidResponse.currency;
        bidResponse.netRevenue = serverBidResponse.netRevenue;
        bidResponse.ad = serverBidResponse.ad;
        bidResponse.ttl = serverBidResponse.ttl;

        bidManager.addBidResponse(bidById[serverBidResponse.requestId].placementCode, bidResponse);

        bidResponseMap[serverBidResponse.requestId] = true;
      }

      for (let i = 0; i < bids.length; ++i) {
        const bid = bids[i];
        if (!bidResponseMap[bid.bidId]) {
          const bidResponse = bidFactory.createBid(2);
          bidResponse.bidderCode = 'lockerdome';
          bidManager.addBidResponse(bid.placementCode, bidResponse);
        }
      }
    }
  }

  return {
    callBids: _gdprWrappedCallBids
  };
}

adapterManager.registerBidAdapter(new LockerDomeAdapter(), 'lockerdome');

module.exports = LockerDomeAdapter;
