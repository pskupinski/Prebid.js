const bidFactory =  require('src/bidfactory.js');
const bidManager = require('src/bidmanager.js');
const adapterManager = require('src/adaptermanager');

function LockerDomeAdapter() {
  function _callBids (params) {
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

    if (!window.XMLHttpRequest || window.XDomainRequest) {
      return bail();
    }

    makeBidRequests(payload);

    function makeBidRequests (payload) {
      const payloadString = JSON.stringify(payload);

      const request = new XMLHttpRequest();
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
    callBids: _callBids
  };
}

adapterManager.registerBidAdapter(new LockerDomeAdapter(), 'lockerdome');

module.exports = LockerDomeAdapter;
