/*
 * Copyright (c) 2015, Joyent, Inc. All rights reserved.
 *
 * Client library for the SmartDataCenter Cloud API (cloudapi).
 * http://apidocs.joyent.com/cloudapi/
 *
 * Usage example::
 *
 *      var auth = require('smartdc-auth');
 *      var cloudapi = require('./lib/cloudapi2');
 *      var client = cloudapi.createClient({
 *              url: <URL>,                 // 'https://us-sw-1.api.joyent.com',
 *              user: <USER>,               // 'bob'
 *              log: <BUNYAN-LOGGER>,
 *              sign: auth.cliSigner({
 *                  keyId: <KEY-ID>,        // ssh fingerprint
 *                  user: <USER>,           // 'bob'
 *                  log: <BUNYAN-LOGGER>,
 *              }),
 *              ...
 *      });
 *      client.listImages(function (err, images) { ... });
 *      ...
 *
 */

var p = console.log;

var assert = require('assert-plus');
var auth = require('smartdc-auth');
var format = require('util').format;
var LOMStream = require('lomstream').LOMStream;
var os = require('os');
var querystring = require('querystring');
var restifyClients = require('restify-clients');
var sprintf = require('util').format;
var vasync = require('vasync');

var errors = require('./errors');



// ---- globals

var VERSION = require('../package.json').version;
var OS_ARCH = os.arch();
var OS_PLATFORM = os.platform();



// ---- internal support stuff

// A no-op bunyan logger shim.
function BunyanNoopLogger() {}
BunyanNoopLogger.prototype.trace = function () {};
BunyanNoopLogger.prototype.debug = function () {};
BunyanNoopLogger.prototype.info = function () {};
BunyanNoopLogger.prototype.warn = function () {};
BunyanNoopLogger.prototype.error = function () {};
BunyanNoopLogger.prototype.fatal = function () {};
BunyanNoopLogger.prototype.child = function () { return this; };
BunyanNoopLogger.prototype.end = function () {};



// ---- client API

/**
 * Create a cloudapi client.
 *
 * @param options {Object}
 *      - {String} url (required) Cloud API base url
 *      - {String} user (required) The user login name.
 *        For backward compat, 'options.account' is accepted as a synonym.
 *      - {Function} sign (required) An http-signature auth signing function
 *      - {String} version (optional) Used for the accept-version header. This
 *        defaults to '*', meaning that over time you could experience breaking
 *        changes. Specifying a value is strongly recommended. E.g. '~7.1'.
 *      - {Bunyan Logger} log (optional)
 *      - ... and any other standard restify client options, e.g.:
 *          {String} userAgent
 *          {Boolean} rejectUnauthorized
 *          {Boolean} agent  Set to `false` to not get KeepAlive. You want
 *              this for CLIs.
 *          TODO doc the backoff/retry available options
 * @throws {TypeError} on bad input.
 * @constructor
 *
 * TODO: caching options (copy node-manta/node-moray/node-smartdc?)
 *        - {Boolean} noCache (optional) disable client caching (default false).
 *        - {Boolean} cacheSize (optional) number of cache entries (default 1k).
 *        - {Boolean} cacheExpiry (optional) entry age in seconds (default 60).
 */
function CloudAPI(options) {
    assert.object(options, 'options');
    assert.string(options.url, 'options.url');
    assert.string(options.user || options.account, 'options.user');
    assert.func(options.sign, 'options.sign');
    assert.optionalString(options.version, 'options.version');
    assert.optionalObject(options.log, 'options.log');

    this.url = options.url;
    this.user = options.user || options.account;
    this.sign = options.sign;
    this.log = options.log || new BunyanNoopLogger();
    if (!options.version) {
        options.version = '*';
    }
    if (!options.userAgent) {
        options.userAgent = sprintf('triton/%s (%s-%s; node/%s)',
            VERSION, OS_ARCH, OS_PLATFORM, process.versions.node);
    }

    // XXX relevant?
    //options.retryCallback = function checkFor500(code) {
    //    return (code === 500);
    //};

    // XXX relevant?
    //this.token = options.token;

    this.client = restifyClients.createJsonClient(options);
}


CloudAPI.prototype._getAuthHeaders = function _getAuthHeaders(callback) {
    assert.func(callback, 'callback');
    var self = this;

    var headers = {};
    headers.date = new Date().toUTCString();
    var sigstr = 'date: ' + headers.date;

    //XXX
    //if (this.token !== undefined) {
    //    obj.headers['X-Auth-Token'] = this.token;
    //}

    self.sign(sigstr, function (err, sig) {
        if (err || !sig) {
            callback(new errors.SigningError(err));
            return;
        }

        headers.authorization = sprintf(
            'Signature keyId="/%s/keys/%s",algorithm="%s",signature="%s"',
            self.user, sig.keyId, sig.algorithm, sig.signature);
        callback(null, headers);
    });
};

/**
 * Return an appropriate query string *with the leading '?'* from the given
 * fields. If any of the field values are undefined or null, then they will
 * be excluded.
 */
CloudAPI.prototype._qs = function _qs(/* fields1, ...*/) {
    var fields = Array.prototype.slice.call(arguments);

    var query = {};
    fields.forEach(function (field) {
        Object.keys(field).forEach(function (key) {
            var value = field[key];
            if (value !== undefined && value !== null) {
                query[key] = value;
            }
        });
    });

    if (Object.keys(query).length === 0) {
        return '';
    } else {
        return '?' + querystring.stringify(query);
    }
};


/**
 * Return an appropriate full URL *path* given an CloudAPI subpath.
 * This handles prepending the API's base path, if any: e.g. if the configured
 * URL is "https://example.com/base/path".
 *
 * Optionally an object of query params can be passed in to include a query
 * string. This just calls `this._qs(...)`.
 */
CloudAPI.prototype._path = function _path(subpath /*, qparams, ... */) {
    assert.string(subpath, 'subpath');
    assert.ok(subpath[0] === '/');

    var path = subpath;
    var qparams = Array.prototype.slice.call(arguments, 1);
    path += this._qs.apply(this, qparams);
    return path;
};


/**
 * Cloud API request wrapper - modeled after http.request
 *
 * @param {Object|String} options - object or string for endpoint
 *      - {String} path - URL endpoint to hit
 *      - {String} method - HTTP(s) request method
 * @param {Function} callback passed via the restify client
 */
CloudAPI.prototype._request = function _request(options, callback) {
    var self = this;
    if (typeof options === 'string')
        options = {path: options};
    assert.object(options, 'options');
    assert.func(callback, 'callback');

    var method = (options.method || 'GET').toLowerCase();
    assert.ok(['get', 'post', 'delete', 'head'].indexOf(method) >= 0,
        'invalid method given');
    self._getAuthHeaders(function (err, headers) {
        if (err) {
            callback(err);
            return;
        }
        var opts = {
            path: options.path,
            headers: headers
        };
        self.client[method](opts, callback);
    });
};



// ---- accounts

/**
 * Get the user's account data.
 * <http://apidocs.joyent.com/cloudapi/#GetAccount>
 *
 * @param {Object} options (optional)
 * @param {Function} callback of the form `function (err, user)`
 */
CloudAPI.prototype.getAccount = function getAccount(options, callback) {
    var self = this;
    if (callback === undefined) {
        callback = options;
        options = {};
    }
    assert.object(options, 'options');
    assert.func(callback, 'callback');

    var path = '/' + self.user;
    self._getAuthHeaders(function (hErr, headers) {
        if (hErr) {
            callback(hErr);
            return;
        }
        var opts = {
            path: path,
            headers: headers
        };
        self.client.get(opts, function (err, req, res, body) {
            if (err) {
                callback(err, null, res);
            } else {
                callback(null, body, res);
            }
        });
    });
};


// ---- images

/**
 * <http://apidocs.joyent.com/cloudapi/#ListImages>
 *
 * @param {Object} options (optional)
 *      XXX document this, see the api doc above :)
 * @param {Function} callback of the form `function (err, images, res)`
 */
CloudAPI.prototype.listImages = function listImages(options, callback) {
    var self = this;
    if (callback === undefined) {
        callback = options;
        options = {};
    }
    assert.object(options, 'options');
    assert.func(callback, 'callback');

    var endpoint = self._path(format('/%s/images', self.user), options);
    self._request(endpoint, function (err, req, res, body) {
        callback(err, body, res);
    });
};


/**
 * <http://apidocs.joyent.com/cloudapi/#ListImages>
 *
 * @param {Object} options
 *      - id {UUID}
 * @param {Function} callback of the form `function (err, image, res)`
 */
CloudAPI.prototype.getImage = function getImage(options, callback) {
    if (callback === undefined) {
        callback = options;
        options = {};
    }
    assert.object(options, 'options');
    assert.uuid(options.id, 'options.id');
    assert.func(callback, 'callback');

    var endpoint = this._path(format('/%s/images/%s', this.user, options.id));
    this._request(endpoint, function (err, req, res, body) {
        callback(err, body, res);
    });
};


// ---- packages

CloudAPI.prototype.listPackages = function listPackages(options, callback) {
    var self = this;
    if (typeof (options) === 'function') {
        callback = options;
        options = {};
    }

    var endpoint = self._path(format('/%s/packages', self.user), options);
    self._request(endpoint, function (err, req, res, body) {
        callback(err, body, res);
    });
};

CloudAPI.prototype.getPackage = function getPackage(options, callback) {
    if (callback === undefined) {
        callback = options;
        options = {};
    }
    assert.object(options, 'options');
    assert.uuid(options.id, 'options.id');
    assert.func(callback, 'callback');

    var endpoint = this._path(format('/%s/packages/%s', this.user, options.id));
    this._request(endpoint, function (err, req, res, body) {
        callback(err, body, res);
    });
};


// ---- machines

/**
 * Get a machine by id.
 *
 * XXX add getCredentials equivalent
 * XXX cloudapi docs don't doc the credentials=true option
 *
 * @param {Object} options
 *      - {String} id (required) The machine id.
 * @param {Function} callback of the form `function (err, machine, response)`
 */
CloudAPI.prototype.getMachine = function getMachine(options, callback) {
    var self = this;
    assert.object(options, 'options');
    assert.string(options.id, 'options.id');
    assert.func(callback, 'callback');

    var path = sprintf('/%s/machines/%s', self.user, options.id);
    self._getAuthHeaders(function (hErr, headers) {
        if (hErr) {
            callback(hErr);
            return;
        }
        var opts = {
            path: path,
            headers: headers
        };
        self.client.get(opts, function (err, req, res, body) {
            if (err) {
                callback(err, null, res);
            } else {
                callback(null, body, res);
            }
        });
    });
};


/**
 * List the user's machines.
 * <http://apidocs.joyent.com/cloudapi/#ListMachines>
 *
 * @param {Object} options
 *      See document above
 * @return {LOMStream} a stream for each machine entry
 */
CloudAPI.prototype.createListMachinesStream =
function createListMachinesStream(options) {
     var self = this;

    // if the user specifies an offset we don't paginate
    var once = options.limit !== undefined;

    return new LOMStream({
        fetch: fetch,
        limit: 1000,
        offset: true
    });

    function fetch(fetcharg, limitObj, datacb, donecb) {
        options.limit = limitObj.limit;
        options.offset = limitObj.offset;
        var endpoint = self._path(format('/%s/machines', self.user), options);

        self._request(endpoint, function (err, req, res, body) {
            var resourcecount = res.headers['x-resource-count'];
            var done = once || resourcecount < options.limit;
            donecb(err, {done: done, results: body});
        });
    }
};

/**
 * List the user's machines.
 * <http://apidocs.joyent.com/cloudapi/#ListMachines>
 *
 * @param {Object} options
 *      See document above
 * @param {Function} callback - called like `function (err, machines)`
 */
CloudAPI.prototype.listMachines = function listMachines(options, callback) {
    var machines = [];
    var s = this.createListMachinesStream(options);
    s.on('error', function (e) {
        callback(e);
    });
    s.on('readable', function () {
        var machine;
        while ((machine = s.read()) !== null) {
            machines.push(machine);
        }
    });
    s.on('end', function () {
        callback(null, machines);
    });
};

/**
 * List machine audit (successful actions on the machine).
 *
 * XXX IMO this endpoint should be called ListMachineAudit in cloudapi.
 *
 * @param {Object} options
 *      - {String} id (required) The machine id.
 * @param {Function} callback of the form `function (err, audit, response)`
 */
CloudAPI.prototype.machineAudit = function machineAudit(options, callback) {
    var self = this;
    assert.object(options, 'options');
    assert.string(options.id, 'options.id');
    assert.func(callback, 'callback');

    var path = sprintf('/%s/machines/%s/audit', self.user, options.id);
    //XXX This `client.get` block is duplicated. Add a convenience function for it:
    self._getAuthHeaders(function (hErr, headers) {
        if (hErr) {
            callback(hErr);
            return;
        }
        var opts = {
            path: path,
            headers: headers
        };
        self.client.get(opts, function (err, req, res, body) {
            if (err) {
                callback(err, null, res);
            } else {
                callback(null, body, res);
            }
        });
    });
};



// --- Exports

module.exports = {
    createClient: function (options) {
        return new CloudAPI(options);
    }
};