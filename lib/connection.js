/*global Buffer */
/**
 * @file Connection class to keep the API session information and manage requests
 * @author Shinichi Tomita <shinichi.tomita@gmail.com>
 */
var events  = require('events'),
    inherits = require('inherits'),
    _       = require('underscore')._,
    Promise = require('./promise'),
    Logger  = require('./logger'),
    OAuth2  = require('./oauth2'),
    Query   = require('./query'),
    SObject = require('./sobject'),
    Transport = require('./transport'),
    Cache   = require('./cache');

var defaults = {
  loginUrl: "https://login.salesforce.com",
  instanceUrl: "",
  version: "32.0"
};

/**
 * Connection class to keep the API session information and manage requests
 *
 * @constructor
 * @extends events.EventEmitter
 * @param {Object} [options] - Connection options
 * @param {OAuth2|Object} [options.oauth2] - OAuth2 instance or options to be passed to OAuth2 constructor
 * @param {String} [options.logLevel] - Output logging level (DEBUG|INFO|WARN|ERROR|FATAL)
 * @param {String} [options.version] - Salesforce API Version (without "v" prefix)
 * @param {Number} [options.maxRequest] - Max number of requests allowed in parallel call
 * @param {String} [options.loginUrl] - Salesforce Login Server URL (e.g. https://login.salesforce.com/)
 * @param {String} [options.instanceUrl] - Salesforce Instance URL (e.g. https://na1.salesforce.com/)
 * @param {String} [options.serverUrl] - Salesforce SOAP service endpoint URL (e.g. https://na1.salesforce.com/services/Soap/u/28.0)
 * @param {String} [options.accessToken] - Salesforce OAuth2 access token
 * @param {String} [options.sessionId] - Salesforce session ID
 * @param {String} [options.refreshToken] - Salesforce OAuth2 refresh token
 * @param {String|Object} [options.signedRequest] - Salesforce Canvas signed request (Raw Base64 string, JSON string, or deserialized JSON)
 * @param {String} [options.proxyUrl] - Cross-domain proxy server URL, used in browser client, non Visualforce app.
 */
var Connection = module.exports = function(options) {
  var Bulk    = require('./api/bulk'),
      Streaming = require('./api/streaming'),
      Tooling = require('./api/tooling'),
      Analytics = require('./api/analytics'),
      Chatter = require('./api/chatter'),
      Apex    = require('./api/apex'),
      Metadata = require('./api/metadata');

  options = options || {};

  this._logger = new Logger(options.logLevel);

  var oauth2 = options.oauth2 || {
    loginUrl : options.loginUrl,
    clientId : options.clientId,
    clientSecret : options.clientSecret,
    redirectUri : options.redirectUri
  };

  /**
   * OAuth2 object
   * @member {OAuth2} Connection#oauth2
   */
  this.oauth2 = oauth2 instanceof OAuth2 ? oauth2 : new OAuth2(oauth2);

  this.loginUrl = options.loginUrl || oauth2.loginUrl || defaults.loginUrl;
  this.version = options.version || defaults.version;
  this.maxRequest = options.maxRequest || this.maxRequest || 10;

  /** @private */
  this._transport =
    options.proxyUrl ? new Transport.ProxyTransport(options.proxyUrl) : new Transport();

  /**
   * Streaming API object
   * @member {Streaming} Connection#streaming
   */
  if (Streaming) {
    this.streaming = new Streaming(this);
  }
  /**
   * Bulk API object
   * @member {Bulk} Connection#bulk
   */
  if (Bulk) {
    this.bulk = new Bulk(this);
  }
  /**
   * Tooling API object
   * @member {Tooling} Connection#tooling
   */
  if (Tooling) {
    this.tooling = new Tooling(this);
  }
  /**
   * Analytics API object
   * @member {Analytics} Connection#analytics
   */
  if (Analytics) {
    this.analytics = new Analytics(this);
  }
  /**
   * Chatter API object
   * @member {Chatter} Connection#chatter
   */
  if (Chatter) {
    this.chatter = new Chatter(this);
  }
  /**
   * Metadata API object
   * @member {Metadata} Connection#metadata 
   */
  if (Metadata) {
    this.metadata = new Metadata(this);
  }
  /**
   * Apex REST API object
   * @member {Apex} Connection#apex
   */
  if (Apex) {
    this.apex = new Apex(this);
  }
  /**
   * Cache object for result
   * @member {Cache} Connection#cache
   */
  this.cache = new Cache();

  // Allow to delegate connection refresh to outer function
  if (options.refreshFn) {
    this._refreshDelegate = {
      refreshToken: options.refreshFn
    };
  }

  var cacheOptions = {
    key: function(type) { return type ? "describe." + type : "describe"; }
  };
  this.describe$ = this.cache.makeCacheable(this.describe, this, cacheOptions);
  this.describe = this.cache.makeResponseCacheable(this.describe, this, cacheOptions);
  this.describeSObject$ = this.describe$;
  this.describeSObject = this.describe;

  cacheOptions = { key: 'describeGlobal' };
  this.describeGlobal$ = this.cache.makeCacheable(this.describeGlobal, this, cacheOptions);
  this.describeGlobal = this.cache.makeResponseCacheable(this.describeGlobal, this, cacheOptions);

  this.initialize(options);
};

inherits(Connection, events.EventEmitter);

/**
 * Initialize connection.
 *
 * @protected
 * @param {Object} options - Initialization options
 * @param {String} [options.instanceUrl] - Salesforce Instance URL (e.g. https://na1.salesforce.com/)
 * @param {String} [options.serverUrl] - Salesforce SOAP service endpoint URL (e.g. https://na1.salesforce.com/services/Soap/u/28.0)
 * @param {String} [options.accessToken] - Salesforce OAuth2 access token
 * @param {String} [options.sessionId] - Salesforce session ID
 * @param {String} [options.refreshToken] - Salesforce OAuth2 refresh token
 * @param {String|Object} [options.signedRequest] - Salesforce Canvas signed request (Raw Base64 string, JSON string, or deserialized JSON)
 * @param {UserInfo} [options.userInfo] - Logged in user information
 */
Connection.prototype.initialize = function(options) {
  if (!options.instanceUrl && options.serverUrl) {
    options.instanceUrl = options.serverUrl.split('/').slice(0, 3).join('/');
  }
  this.instanceUrl = options.instanceUrl || options.serverUrl || this.instanceUrl || defaults.instanceUrl;
  this.urls = {
    soap : {
      login : [ this.loginUrl, "services/Soap/u", this.version ].join('/'),
      service : [ this.instanceUrl, "services/Soap/u", this.version ].join('/')
    },
    rest : {
      base : [ this.instanceUrl, "services/data", "v" + this.version ].join('/')
    }
  };

  this.accessToken = options.sessionId || options.accessToken || this.accessToken;
  this.refreshToken = options.refreshToken || this.refreshToken;
  if (this.refreshToken && !this.oauth2 && !this._refreshDelegate) {
    throw new Error("Refresh token is specified without oauth2 client information");
  }
  
  this.signedRequest = options.signedRequest && parseSignedRequest(options.signedRequest);
  if (this.signedRequest) {
    this.accessToken = this.signedRequest.client.oauthToken;
  }

  if (options.userInfo) {
    this.userInfo = options.userInfo;
  }

  this.limitInfo = {};

  this.sobjects = {};
  this.cache.clear();
  this.cache.get('describeGlobal').on('value', _.bind(function(res) {
    if (res.result) {
      var types = _.map(res.result.sobjects, function(so) { return so.name; });
      _.each(types, this.sobject, this);
    }
  }, this));

  if (this.tooling) {
    this.tooling.initialize();
  }

  this._sessionType = options.sessionId ? "soap" : "oauth2";
  this._initializedAt = Date.now();

};

/** @private **/
function parseSignedRequest(sr) {
  if (_.isString(sr)) {
    if (sr[0] === '{') { // might be JSON
      return JSON.parse(sr);
    } else { // might be original base64-encoded signed request
      var msg = sr.split('.').pop(); // retrieve latter part
      var json = new Buffer(msg, 'base64').toString('utf-8');
      return JSON.parse(json);
    }
    return null;
  }
  return sr;
}


/**
 * @private
 */
Connection.prototype._baseUrl = function() {
  return this.urls.rest.base;
};

/**
 * Sending request using given HTTP request info
 * @private
 */
Connection.prototype._request = function(params, callback, options) {
  options = options || {};
  // if params is simple string, regard it as url in GET method
  if (_.isString(params)) {
    params = { method: 'GET', url: params };
  }
  // if url is given in site root relative path, prepend instance url before.
  if (params.url[0] === '/') {
    params.url = this.instanceUrl + params.url;
  }

  var self = this;
  var logger = this._logger;

  var deferred = Promise.defer();

  var onResume = function(err) {
    if (err) {
      deferred.reject(err);
      return;
    }
    self._request(params, null, options).then(function(response) {
      deferred.resolve(response);
    }, function(err) {
      deferred.reject(err);
    });
  };

  if (self._suspended) {
    self.once('resume', onResume);
    return deferred.promise.thenCall(callback);
  }

  params.headers = params.headers || {};
  if (this.accessToken) {
    params.headers.Authorization = "Bearer " + this.accessToken;
  }

  // hook in sending
  if (options.beforesend) { options.beforesend(this, params); }

  // for connection in canvas with signed request
  if (this.signedRequest) { options.signedRequest = this.signedRequest; }

  // for session expiraty detection
  var isSessionExpired = options.isSessionExpired || function(response) {
    return response.statusCode === 401;
  };

  // for error detection
  var isErrorResponse = options.isErrorResponse || function(response) {
    return response.statusCode >= 400;
  };

  // for parsing error message in response
  var parseError = options.parseError || function(errs) {
    var err = _.isArray(errs) ? errs[0] : errs;
    if (_.isObject(err) && _.isString(err.message)) { return err; }
  };

  self.emit('request', params.method, params.url, params);

  logger.debug("<request> method=" + params.method + ", url=" + params.url);
  var requestTime = Date.now();

  var onFailure = function(err) {
    var responseTime = Date.now();
    logger.debug("elappsed time : " + (responseTime - requestTime) + "msec");

    logger.error(err);
    throw err;
  };

  var onResponse = function(response) {
    var responseTime = Date.now();
    logger.debug("elappsed time : " + (responseTime - requestTime) + "msec");

    logger.debug("<response> status=" + response.statusCode + ", url=" + params.url);

    // log api usage and its quota
    if (response.headers && response.headers["sforce-limit-info"]) {
      var apiUsage = response.headers["sforce-limit-info"].match(/api\-usage=(\d+)\/(\d+)/);
      if (apiUsage) {
        self.limitInfo = {
          apiUsage: {
            used: parseInt(apiUsage[1], 10),
            limit: parseInt(apiUsage[2], 10)
          }
        };
      }
    }

    self.emit('response', response.statusCode, response.body, response);

    // Refresh token if status code requires authentication
    // when oauth2 info and refresh token is available.
    if (isSessionExpired(response) &&
        (self._refreshDelegate || (self.oauth2 && self.refreshToken))) {
      // Access token may be refreshed before the response
      if (self._initializedAt > requestTime) {
        onResume();
      } else {
        self.once('resume', onResume);
        if (!self._suspended) {
          self._suspended = true;
          self._refresh();
        }
      }
      return deferred.promise;
    } else if (response.statusCode === 401 && self.username && self.password) {
      self.once('resume', onResume);
      if (!self._suspended) {
        self._suspended = true;
        self._refresh();
      }
      return deferred.promise;
    }

    // check response content type to choose parser
    var contentType = options.responseContentType ||
                      (response.headers && response.headers["content-type"]);
    var parseBody = /^application\/xml(;|$)/.test(contentType) ? parseXML : 
                    /^application\/json(;|$)/.test(contentType) ? parseJSON :
                    /^text\/csv(;|$)/.test(contentType) ? parseCSV :
                    parseText;

    var err;
    if (isErrorResponse(response)) {
      var error;
      try {
        error = parseError(parseBody(response.body));
      } catch(e) {}
      if (!error) {
        error = { message : response.body, errorCode: 'ERROR_HTTP_' + response.statusCode };
      }
      err = new Error(error.message);
      err.name = error.errorCode;
      for (var key in error) { err[key] = error[key]; }
      throw err;
    } else if (response.statusCode === 204) {
      return options.noContentResponse;
    } else {
      var res = parseBody(response.body);
      if (response.statusCode === 300) { // Multiple Choices
        err = new Error('Multiple records found');
        err.name = "MULTIPLE_CHOICES";
        err.content = res;
        throw err;
      }
      return res;
    }
  };

  return this._transport.httpRequest(params, null, options).then(onResponse, onFailure).thenCall(callback);

};

/** @private */
function parseJSON(str) {
  return JSON.parse(str);
}

/** @private */
function parseXML(str) {
  var ret = {};
  require('xml2js').parseString(str, { explicitArray: false }, function(err, result) {
    ret = { error: err, result : result };
  });
  if (ret.error) { throw ret.error; }
  return ret.result;
}

/** @private */
function parseCSV(str) {
  return require('./csv').parseCSV(str);
}

/** @private */
function parseText(str) { return str; }

/** @private */
function formatDate(date) {
  function pad(number) {
    if (number < 10) {
      return '0' + number;
    }
    return number;
  }

  return date.getUTCFullYear() +
    '-' + pad(date.getUTCMonth() + 1) +
    '-' + pad(date.getUTCDate()) +
    'T' + pad(date.getUTCHours()) +
    ':' + pad(date.getUTCMinutes()) +
    ':' + pad(date.getUTCSeconds()) +
    '+00:00';
}

/**
 * Refresh access token
 * @private
 */
Connection.prototype._refresh = function() {
  var self = this;
  var logger = this._logger;
  logger.debug("<refresh token>");
  if (self._refreshDelegate || (self.oauth2 && self.refreshToken)) {
    var delegate = this._refreshDelegate || this.oauth2;
    return delegate.refreshToken(this.refreshToken, function(err, res) {
      if (!err) {
        var userInfo = parseIdUrl(res.id);
        self.initialize({
          instanceUrl : res.instance_url,
          accessToken : res.access_token,
          userInfo : userInfo
        });
        logger.debug("token refresh completed. result = " + JSON.stringify(res));
        self.emit("refresh", res.access_token, res);
      }
      self._suspended = false;
      self.emit('resume', err);
    });
  } else if (self.username && self.password) {
    return self.login(self.username, self.password, function(err, res) {
      if (!err) {
        var userInfo = parseIdUrl(res.id);
        logger.debug("token refresh completed. result = " + JSON.stringify(res));
        self.emit("refresh", self.accessToken, res);
      }
      self._suspended = false;
      self.emit('resume', err);
    });
  }
};

/** @private **/
function parseIdUrl(idUrl) {
  var idUrls = idUrl.split("/");
  var userId = idUrls.pop(), orgId = idUrls.pop();
  return {
    id: userId,
    organizationId: orgId,
    url: idUrl
  };
}


/**
 * @callback Callback
 * @type {Function}
 * @param {Error} err - Callback error
 * @param {T} response - Callback response
 * @template T
 */

/**
 * @typedef {Object} QueryResult
 * @prop {Boolean} done - Flag if the query is fetched all records or not
 * @prop {String} [nextRecordsUrl] - URL locator for next record set, (available when done = false)
 * @prop {Number} totalSize - Total size for query
 * @prop {Array.<Record>} [records] - Array of records fetched
 */

/**
 * Execute query by using SOQL
 * 
 * @param {String} soql - SOQL string
 * @param {Callback.<QueryResult>} [callback] - Callback function
 * @returns {Query.<QueryResult>}
 */
Connection.prototype.query = function(soql, callback) {
  var query = new Query(this, soql);
  if (callback) {
    query.run(callback);
  }
  return query;
};

/**
 * Execute query by using SOQL, including deleted records
 * 
 * @param {String} soql - SOQL string
 * @param {Callback.<QueryResult>} [callback] - Callback function
 * @returns {Query.<QueryResult>}
 */
Connection.prototype.queryAll = function(soql, callback) {
  var query = new Query(this, soql);
  query.scanAll(true);
  if (callback) {
    query.run(callback);
  }
  return query;
};

/**
 * Query next record set by using query locator
 * 
 * @param {String} locator - Next record set locator
 * @param {Callback.<QueryResult>} [callback] - Callback function
 * @returns {Query.<QueryResult>}
 */
Connection.prototype.queryMore = function(locator, callback) {
  var query = new Query(this, null, locator);
  if (callback) {
    query.run(callback);
  }
  return query;
};

/**
 * Retrieve specified records
 *
 * @param {String} type - SObject Type
 * @param {String|Array.<String>} ids - A record ID or array of record IDs 
 * @param {Object} [options] - Options for rest api.
 * @param {Callback.<Record|Array.<Record>>} [callback] - Callback function
 * @returns {Promise.<Record|Array.<Record>>}
 */
Connection.prototype.retrieve = function(type, ids, options, callback) {
  if (typeof options === 'function') {
    callback = options;
    options = {};
  }
  var self = this;
  var isArray = _.isArray(ids);
  ids = isArray ? ids : [ ids ];
  if (ids.length > self.maxRequest) {
    return Promise.reject(new Error("Exceeded max limit of concurrent call")).thenCall(callback);
  }
  return Promise.all(
    _.map(ids, function(id) {
      var url = [ self._baseUrl(), "sobjects", type, id ].join('/');
      return self._request(url);
    })
  ).then(function(results) {
    return !isArray && _.isArray(results) ? results[0] : results;
  }).thenCall(callback);
};


/**
 * @typedef RecordResult
 * @prop {Boolean} success - The result is succeessful or not
 * @prop {String} [id] - Record ID
 * @prop {Array.<String>} [errors] - Errors (available when success = false)
 */

/**
 * Synonym of Connection#create()
 *
 * @method Connection#insert
 * @param {String} type - SObject Type
 * @param {Object|Array.<Object>} records - A record or array of records to create
 * @param {Callback.<RecordResult|Array.<RecordResult>>} [callback] - Callback function
 * @returns {Promise.<RecordResult|Array.<RecordResult>>}
 */
/**
 * Create records
 *
 * @method Connection#create
 * @param {String} type - SObject Type
 * @param {Record|Array.<Record>} records - A record or array of records to create
 * @param {Object} [options] - Options for rest api.
 * @param {Callback.<RecordResult|Array.<RecordResult>>} [callback] - Callback function
 * @returns {Promise.<RecordResult|Array.<RecordResult>>}
 */
Connection.prototype.insert =
Connection.prototype.create = function(type, records, options, callback) {
  if (!_.isString(type)) {
    // reverse order
    callback = options;
    options = records;
    records = type;
    type = null;
  }
  if (typeof options === 'function') {
    callback = options;
    options = {};
  }
  options = options || {};
  var self = this;
  var isArray = _.isArray(records);
  records = isArray ? records : [ records ];
  if (records.length > self.maxRequest) {
    return Promise.reject(new Error("Exceeded max limit of concurrent call")).thenCall(callback);
  }
  return Promise.all(
    _.map(records, function(record) {
      var sobjectType = type || (record.attributes && record.attributes.type) || record.type;
      if (!sobjectType) {
        throw new Error('No SObject Type defined in record');
      }
      record = _.clone(record);
      delete record.Id;
      delete record.type;
      delete record.attributes;

      var url = [ self._baseUrl(), "sobjects", sobjectType ].join('/');
      return self._request({
        method : 'POST',
        url : url,
        body : JSON.stringify(record),
        headers : _.defaults(options.headers || {}, {
          "Content-Type" : "application/json"
        })
      });
    })
  ).then(function(results) {
    return !isArray && _.isArray(results) ? results[0] : results;
  }).thenCall(callback);
};

/**
 * Update records
 *
 * @param {String} type - SObject Type
 * @param {Record|Array.<Record>} records - A record or array of records to update
 * @param {Object} [options] - Options for rest api.
 * @param {Callback.<RecordResult|Array.<RecordResult>>} [callback] - Callback function
 * @returns {Promise.<RecordResult|Array.<RecordResult>>}
 */
Connection.prototype.update = function(type, records, options, callback) {
  if (!_.isString(type)) {
    // reverse order
    callback = options;
    options = records;
    records = type;
    type = null;
  }
  if (typeof options === 'function') {
    callback = options;
    options = {};
  }
  options = options || {};
  var self = this;
  var isArray = _.isArray(records);
  records = isArray ? records : [ records ];
  if (records.length > self.maxRequest) {
    return Promise.reject(new Error("Exceeded max limit of concurrent call")).thenCall(callback);
  }
  return Promise.all(
    _.map(records, function(record) {
      var id = record.Id;
      if (!id) {
        throw new Error('Record id is not found in record.');
      }
      var sobjectType = type || (record.attributes && record.attributes.type) || record.type;
      if (!sobjectType) {
        throw new Error('No SObject Type defined in record');
      }
      record = _.clone(record);
      delete record.Id;
      delete record.type;
      delete record.attributes;

      var url = [ self._baseUrl(), "sobjects", sobjectType, id ].join('/');
      return self._request({
        method : 'PATCH',
        url : url,
        body : JSON.stringify(record),
        headers : _.defaults(options.headers || {}, {
          "Content-Type" : "application/json"
        })
      }, null, {
        noContentResponse: { id : id, success : true, errors : [] }
      });
    })
  ).then(function(results) {
    return !isArray && _.isArray(results) ? results[0] : results;
  }).thenCall(callback);
};

/**
 * Upsert records
 *
 * @param {String} type - SObject Type
 * @param {Record|Array.<Record>} records - Record or array of records to upsert
 * @param {String} extIdField - External ID field name
 * @param {Object} [options] - Options for rest api.
 * @param {Callback.<RecordResult|Array.<RecordResult>>} [callback] - Callback
 * @returns {Promise.<RecordResult|Array.<RecordResult>>}
 */
Connection.prototype.upsert = function(type, records, extIdField, options, callback) {
  // You can omit "type" argument, when the record includes type information.
  if (!_.isString(type)) {
    // reverse order
    callback = options;
    options = extIdField;
    extIdField = records;
    records = type;
    type = null;
  }
  if (typeof options === 'function') {
    callback = options;
    options = {};
  }
  options = options || {};
  var self = this;
  var isArray = _.isArray(records);
  records = isArray ? records : [ records ];
  if (records.length > self.maxRequest) {
    return Promise.reject(new Error("Exceeded max limit of concurrent call")).thenCall(callback);
  }
  return Promise.all(
    _.map(records, function(record) {
      var sobjectType = type || (record.attributes && record.attributes.type) || record.type;
      var extId = record[extIdField];
      if (!extId) {
        return Promise.reject(new Error('External ID is not defined in the record'));
      }
      record = _.clone(record);
      delete record[extIdField];
      delete record.type;
      delete record.attributes;

      var url = [ self._baseUrl(), "sobjects", sobjectType, extIdField, extId ].join('/');
      return self._request({
        method : 'PATCH',
        url : url,
        body : JSON.stringify(record),
        headers : _.defaults(options.headers || {}, {
          "Content-Type" : "application/json"
        }) 
      }, null, {
        noContentResponse: { success : true, errors : [] }
      });
    })
  ).then(function(results) {
    return !isArray && _.isArray(results) ? results[0] : results;
  }).thenCall(callback);
};

/**
 * Synonym of Connection#destroy()
 *
 * @method Connection#delete
 * @param {String} type - SObject Type
 * @param {String|Array.<String>} ids - A ID or array of IDs to delete
 * @param {Object} [options] - Options for rest api.
 * @param {Callback.<RecordResult|Array.<RecordResult>>} [callback] - Callback
 * @returns {Promise.<RecordResult|Array.<RecordResult>>}
 */
/**
 * Synonym of Connection#destroy()
 *
 * @method Connection#del
 * @param {String} type - SObject Type
 * @param {String|Array.<String>} ids - A ID or array of IDs to delete
 * @param {Object} [options] - Options for rest api.
 * @param {Callback.<RecordResult|Array.<RecordResult>>} [callback] - Callback
 * @returns {Promise.<RecordResult|Array.<RecordResult>>}
 */
/**
 * Delete records
 *
 * @method Connection#destroy
 * @param {String} type - SObject Type
 * @param {String|Array.<String>} ids - A ID or array of IDs to delete
 * @param {Object} [options] - Options for rest api.
 * @param {Callback.<RecordResult|Array.<RecordResult>>} [callback] - Callback
 * @returns {Promise.<RecordResult|Array.<RecordResult>>}
 */
Connection.prototype["delete"] =
Connection.prototype.del =
Connection.prototype.destroy = function(type, ids, options, callback) {
  if (typeof options === 'function') {
    callback = options;
    options = {};
  }
  options = options || {};
  var self = this;
  var isArray = _.isArray(ids);
  ids = isArray ? ids : [ ids ];
  if (ids.length > self.maxRequest) {
    return Promise.reject(new Error("Exceeded max limit of concurrent call")).thenCall(callback);
  }
  return Promise.all(
    _.map(ids, function(id) {
      var url = [ self._baseUrl(), "sobjects", type, id ].join('/');
      return self._request({
        method : 'DELETE',
        url : url,
        headers: options.headers || null
      }, null, {
        noContentResponse: { id : id, success : true, errors : [] }
      });
    })
  ).then(function(results) {
    return !isArray && _.isArray(results) ? results[0] : results;
  }).thenCall(callback);
};

/**
 * Execute search by SOSL
 * 
 * @param {String} sosl - SOSL string
 * @param {Callback.<Array.<RecordResult>>} [callback] - Callback function
 * @returns {Promise.<Array.<RecordResult>>}
 */
Connection.prototype.search = function(sosl, callback) {
  var url = this._baseUrl() + "/search?q=" + encodeURIComponent(sosl);
  return this._request(url).thenCall(callback);
};

/**
 * Result returned by describeSObject call
 *
 * @typedef {Object} DescribeSObjectResult
 */
/**
 * Synonym of Connection#describe()
 *
 * @method Connection#describeSObject
 * @param {String} type - SObject Type
 * @param {Callback.<DescribeSObjectResult>} [callback] - Callback function
 * @returns {Promise.<DescribeSObjectResult>}
 */
/**
 * Describe SObject metadata
 *
 * @method Connection#describe
 * @param {String} type - SObject Type
 * @param {Callback.<DescribeSObjectResult>} [callback] - Callback function
 * @returns {Promise.<DescribeSObjectResult>}
 */
Connection.prototype.describe = 
Connection.prototype.describeSObject = function(type, callback) {
  var url = [ this._baseUrl(), "sobjects", type, "describe" ].join('/');
  return this._request(url).thenCall(callback);
};


/**
 * Result returned by describeGlobal call
 *
 * @typedef {Object} DescribeGlobalResult
 */
/**
 * Describe global SObjects
 *
 * @param {Callback.<DescribeGlobalResult>} [callback] - Callback function
 * @returns {Promise.<DescribeGlobalResult>}
 */
Connection.prototype.describeGlobal = function(callback) {
  var url = this._baseUrl() + "/sobjects";
  return this._request(url).thenCall(callback);
};


/**
 * Get SObject instance
 *
 * @param {String} type - SObject Type
 * @returns {SObject}
 */
Connection.prototype.sobject = function(type) {
  this.sobjects = this.sobjects || {};
  var sobject = this.sobjects[type] = 
    this.sobjects[type] || new SObject(this, type);
  return sobject;
};

/**
 * Get identity information of current user
 *
 * @param {Callback.<IdentityInfo>} [callback] - Callback function
 * @returns {Promise.<IdentityInfo>}
 */
Connection.prototype.identity = function(callback) {
  var self = this;
  var idUrl = this.userInfo && this.userInfo.url;
  return new Promise(
    idUrl ? 
    { identity: idUrl } :
    this._request(this._baseUrl())
  ).then(function(res) {
    var url = res.identity;
    url += '?format=json&oauth_token=' + encodeURIComponent(self.accessToken);
    return self._request(url, null, { jsonp : 'callback' });
  }).then(function(res) {
    self.userInfo = {
      id: res.user_id,
      organizationId: res.organization_id,
      url: res.id
    };
    return res;
  }).thenCall(callback);
};

/**
 * @typedef UserInfo
 * @prop {String} id - User ID
 * @prop {String} organizationId - Organization ID
 * @prop {String} url - Identity URL of the user
 */

/**
 * Authorize (using oauth2 web server flow)
 *
 * @param {String} code - Authorization code
 * @param {Callback.<UserInfo>} [callback] - Callback function
 * @returns {Promise.<UserInfo>}
 */
Connection.prototype.authorize = function(code, callback) {
  var self = this;
  var logger = this._logger;

  return this.oauth2.requestToken(code).then(function(res) {
    logger.debug("OAuth2 token response = " + JSON.stringify(res));
    var userInfo = parseIdUrl(res.id);
    self.initialize({
      instanceUrl : res.instance_url,
      accessToken : res.access_token,
      refreshToken : res.refresh_token,
      userInfo: userInfo
    });
    logger.debug("<login> completed. user id = " + userInfo.id + ", org id = " + userInfo.organizationId);
    return userInfo;

  }).thenCall(callback);

};


/**
 * Login to Salesforce
 * 
 * @param {String} username - Salesforce username
 * @param {String} password - Salesforce password (and security token, if required)
 * @param {Callback.<UserInfo>} [callback] - Callback function
 * @returns {Promise.<UserInfo>}
 */
Connection.prototype.login = function(username, password, callback) {
  this.username = username;
  this.password = password;
  if (this.oauth2 && this.oauth2.clientId && this.oauth2.clientSecret) {
    return this.loginByOAuth2(username, password, callback);
  } else {
    return this.loginBySoap(username, password, callback);
  }
};


/**
 * Login by OAuth2 username & password flow
 *
 * @param {String} username - Salesforce username
 * @param {String} password - Salesforce password (and security token, if required)
 * @param {Callback.<UserInfo>} [callback] - Callback function
 * @returns {Promise.<UserInfo>}
 */
Connection.prototype.loginByOAuth2 = function(username, password, callback) {
  var self = this;
  var logger = this._logger;
  this.username = username;
  this.password = password;
  return this.oauth2.authenticate(username, password).then(function(res) {
    logger.debug("OAuth2 token response = " + JSON.stringify(res));
    var userInfo = parseIdUrl(res.id);
    self.initialize({
      instanceUrl : res.instance_url,
      accessToken : res.access_token,
      userInfo: userInfo
    });
    logger.debug("<login> completed. user id = " + userInfo.id + ", org id = " + userInfo.organizationId);
    return userInfo;

  }).thenCall(callback);

};

/**
 * @private
 */
function esc(str) {
  return str && String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;')
                           .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Login by SOAP web service API
 *
 * @param {String} username - Salesforce username
 * @param {String} password - Salesforce password (and security token, if required)
 * @param {Callback.<UserInfo>} [callback] - Callback function
 * @returns {Promise.<UserInfo>}
 */
Connection.prototype.loginBySoap = function(username, password, callback) {
  var self = this;
  var logger = this._logger;
  var body = [
    '<se:Envelope xmlns:se="http://schemas.xmlsoap.org/soap/envelope/">',
      '<se:Header/>',
      '<se:Body>',
        '<login xmlns="urn:partner.soap.sforce.com">',
          '<username>' + esc(username) + '</username>',
          '<password>' + esc(password) + '</password>',
        '</login>',
      '</se:Body>',
    '</se:Envelope>'
  ].join('');

  return this._transport.httpRequest({
    method : 'POST',
    url : this.urls.soap.login,
    body : body,
    headers : {
      "Content-Type" : "text/xml",
      "SOAPAction" : '""'
    }
  }).then(function(response) {
    var m;
    if (response.statusCode >= 400) {
      m = response.body.match(/<faultstring>([^<]+)<\/faultstring>/);
      var faultstring = m && m[1];
      throw new Error(faultstring || response.body);
    }
    logger.debug("SOAP response = " + response.body);
    m = response.body.match(/<serverUrl>([^<]+)<\/serverUrl>/);
    var serverUrl = m && m[1];
    m = response.body.match(/<sessionId>([^<]+)<\/sessionId>/);
    var sessionId = m && m[1];
    m = response.body.match(/<userId>([^<]+)<\/userId>/);
    var userId = m && m[1];
    m = response.body.match(/<organizationId>([^<]+)<\/organizationId>/);
    var orgId = m && m[1];
    var idUrl = self.urls.soap.login.split('/').slice(0, 3).join('/');
    idUrl += "/id/" + orgId + "/" + userId;
    var userInfo = {
      id: userId,
      organizationId: orgId,
      url: idUrl
    };
    self.initialize({ 
      serverUrl: serverUrl.split('/').slice(0, 3).join('/'), 
      sessionId: sessionId,
      userInfo: userInfo
    });
    logger.debug("<login> completed. user id = " + userId + ", org id = " + orgId);
    return userInfo;

  }).thenCall(callback);

};

/**
 * Logout the current session
 *
 * @param {Callback.<undefined>} [callback] - Callback function
 * @returns {Promise.<undefined>}
 */
Connection.prototype.logout = function(callback) {
  if (this._sessionType === "oauth2") {
    return this.logoutByOAuth2(callback);
  } else {
    return this.logoutBySoap(callback);
  }
};

/**
 * Logout the current session by revoking access token via OAuth2 session revoke
 *
 * @param {Callback.<undefined>} [callback] - Callback function
 * @returns {Promise.<undefined>}
 */
Connection.prototype.logoutByOAuth2 = function(callback) {
  var self = this;
  var logger = this._logger;

  return this.oauth2.revokeToken(this.accessToken).then(function() {
    // Destroy the session bound to this connection
    self.username = null;
    self.password = null;
    self.accessToken = null;
    self.userInfo = null;
    self.refreshToken = null;
    self.instanceUrl = null;
    self.cache.clear();

    // nothing useful returned by logout API, just return
    return undefined;
  }).thenCall(callback);
};


/**
 * Logout the session by using SOAP web service API
 *
 * @param {Callback.<undefined>} [callback] - Callback function
 * @returns {Promise.<undefined>}
 */
Connection.prototype.logoutBySoap = function(callback) {
  var self = this;
  var logger = this._logger;

  var body = [
    '<se:Envelope xmlns:se="http://schemas.xmlsoap.org/soap/envelope/">',
      '<se:Header>',
        '<SessionHeader xmlns="urn:partner.soap.sforce.com">',
          '<sessionId>' + esc(this.accessToken) + '</sessionId>',
        '</SessionHeader>',
      '</se:Header>',
      '<se:Body>',
        '<logout xmlns="urn:partner.soap.sforce.com"/>',
      '</se:Body>',
    '</se:Envelope>'
  ].join('');

  return this._transport.httpRequest({
    method : 'POST',
    url : this.urls.soap.service,
    body : body,
    headers : {
      "Content-Type" : "text/xml",
      "SOAPAction" : '""'
    }
  }).then(function(response) {
    logger.debug("SOAP statusCode = " + response.statusCode + ", response = " + response.body);
    if (response.statusCode >= 400) {
      var m = response.body.match(/<faultstring>([^<]+)<\/faultstring>/);
      var faultstring = m && m[1];
      throw new Error(faultstring || response.body);
    }

    // Destroy the session bound to this connection
    self.username = null;
    self.password = null;
    self.accessToken = null;
    self.userInfo = null;
    self.refreshToken = null;
    self.instanceUrl = null;
    self.cache.clear();

    // nothing useful returned by logout API, just return
    return undefined;

  }).thenCall(callback);
};

/**
 * List recently viewed records
 * 
 * @param {String} [type] - SObject type
 * @param {Number} [limit] - Limit num to fetch
 * @param {Callback.<Array.<RecordResult>>} [callback] - Callback function
 * @returns {Promise.<Array.<RecordResult>>}
 */
Connection.prototype.recent = function(type, limit, callback) {
  if (!_.isString(type)) {
    callback = limit;
    limit = type;
    type = undefined;
  }
  if (!_.isNumber(limit)) {
    callback = limit;
    limit = undefined;
  }
  var url;
  if (type) {
    url = [ this._baseUrl(), "sobjects", type ].join('/');
    return this._request(url).then(function(res) {
      return limit ? res.recentItems.slice(0, limit) : res.recentItems;
    }).thenCall(callback);
  } else {
    url = this._baseUrl() + "/recent";
    if (limit) { 
      url += "?limit=" + limit;
    }
    return this._request(url).thenCall(callback);
  }

};

/**
 * @typedef {Object} UpdatedRecordsInfo
 * @prop {String} latestDateCovered - The timestamp of the last date covered. 
 * @prop {Array.<String>} ids - Updated record IDs.
 */

/**
 * Retrieve updated records
 *
 * @param {String} type - SObject Type
 * @param {String|Date} start - start date or string representing the start of the interval
 * @param {String|Date} end - start date or string representing the end of the interval must be > start
 * @param {Callback.<UpdatedRecordsInfo>} [callback] - Callback function
 * @returns {Promise.<UpdatedRecordsInfo>}
 */
Connection.prototype.updated = function (type, start, end, callback) {
  var url = [ this._baseUrl(), "sobjects", type, "updated" ].join('/');

  if (typeof start === 'string') {
    start = new Date(start);
  }

  if (start instanceof Date) {
    start = formatDate(start);
  }

  if (start) {
    url += "?start=" + encodeURIComponent(start);
  }

  if (typeof end === 'string') {
    end = new Date(end);
  }

  if (end instanceof Date) {
    end = formatDate(end);
  }

  if (end) {
    url += "&end=" + encodeURIComponent(end);
  }

  return this._request(url).thenCall(callback);
};

/**
 * @typedef {Object} DeletedRecordsInfo
 * @prop {String} earliestDateAvailable - The timestamp of the earliest date available
 * @prop {String} latestDateCovered - The timestamp of the last date covered
 * @prop {Array.<Object>} deletedRecords - Updated records
 * @prop {String} deletedRecords.id - Record ID
 * @prop {String} deletedRecords.deletedDate - The timestamp when this record was deleted
 */

/**
 * Retrieve deleted records
 *
 * @param {String} type - SObject Type
 * @param {String|Date} start - start date or string representing the start of the interval
 * @param {String|Date} end - start date or string representing the end of the interval
 * @param {Callback.<DeletedRecordsInfo>} [callback] - Callback function
 * @returns {Promise.<DeletedRecordsInfo>}
 */
Connection.prototype.deleted = function (type, start, end, callback) {
  var url = [ this._baseUrl(), "sobjects", type, "deleted" ].join('/');

  if (typeof start === 'string') {
    start = new Date(start);
  }

  if (start instanceof Date) {
    start = formatDate(start);
  }

  if (start) {
    url += "?start=" + encodeURIComponent(start);
  }

  if (typeof end === 'string') {
    end = new Date(end);
  }

  if (end instanceof Date) {
    end = formatDate(end);
  }

  if (end) {
    url += "&end=" + encodeURIComponent(end);
  }

  return this._request(url).thenCall(callback);
};


/**
 * @typedef {Object} TabsInfo - See the API document for detail structure
 */

/**
 * Returns a list of all tabs
 *
 * @param {Callback.<TabsInfo>} [callback] - Callback function
 * @returns {Promise.<TabsInfo>}
 */
Connection.prototype.tabs = function(callback) {
  var url = [ this._baseUrl(), "tabs" ].join('/');
  return this._request(url).thenCall(callback);
};


/**
 * @typedef {Object} LimitsInfo - See the API document for detail structure
 */

/**
 * Returns curren system limit in the organization
 *
 * @param {Callback.<LimitsInfo>} [callback] - Callback function
 * @returns {Promise.<LimitsInfo>}
 */
Connection.prototype.limits = function(callback) {
  var url = [ this._baseUrl(), "limits" ].join('/');
  return this._request(url).thenCall(callback);
};


/**
 * @typedef {Object} ThemeInfo - See the API document for detail structure
 */

/**
 * Returns a theme info
 *
 * @param {Callback.<ThemeInfo>} [callback] - Callback function
 * @returns {Promise.<ThemeInfo>}
 */
Connection.prototype.theme = function(callback) {
  var url = [ this._baseUrl(), "theme" ].join('/');
  return this._request(url).thenCall(callback);
};

