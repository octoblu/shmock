var _       = require("lodash");
var express = require("express");
var methods = require("methods");
var assert  = require("chai").assert;
var chalk   = require("chalk");
var diff    = require("diff");
var querystring = require("querystring");
var EventEmitter = require("events").EventEmitter;
var util = require("util");

module.exports = function(port, middlewares) {
  var app = express();

  app.on("error", function(err) {
    throw err;
  });

  app.use(express.json());
  app.use(express.urlencoded());

  // If the user has defined custom middlewares...
  if(middlewares) {
    // Iterate over them...
    middlewares.forEach(function(middleware) {
      // ... and injet them into the Express app
      app.use(middleware);
    });
  }

  app.use(function(req, res, next){
    if (req.is('text/*')) {
      req.text = '';
      req.setEncoding('utf8');
      req.on('data', function(chunk){ req.text += chunk });
      req.on('end', next);
    } else {
      next();
    }
  });

  var server;
  if(port) {
    server = app.listen(port);
  } else {
    server = app.listen();
  }

  methods.forEach(function(method) {
    server[method] = function(path) {
      return new Assertion(app, method, path);
    }
  });

  server.clean = function() {
    app._router.map = {};
  }

  return server;
}

function Assertion(app, method, path) {
  var self = this;
  this.app = app;
  this.method = method;
  this.path = path;
  this.headers = {};
  this.isDone = false;
  this.removeWhenMet = true;

  this.parseExpectedRequestBody = function() {
    if(!self.headers["content-type"]) {
      if(typeof self.data == "string") {
        return self.requestBody = querystring.parse(self.data);
      }
    }
    self.requestBody = self.data;
  }
}

Assertion.prototype.send = function(data) {
  this.data = data;
  return this;
}

Assertion.prototype.query = function(qs) {
  var q;
  if(typeof qs == "string") {
    q = querystring.parse(qs);
  } else {
    q = qs;
  }
  if(!this.qs) {
    this.qs = {};
  }
  for(var n in q) {
    this.qs[n] = q[n];
  }
  return this;
}

Assertion.prototype.set = function(name, value) {
  this.headers[name.toLowerCase()] = value;
  return this;
}


Assertion.prototype.delay = function(ms) {
  this.delay_ms = ms;
  return this;
}

Assertion.prototype.persist = function() {
  this.removeWhenMet = false;
  return this;
}

function printDiff(parts) {
  parts.forEach(function (part) {
    part.value
      .split('\n')
      .filter(function (line) { return !!line; })
      .forEach(function (line) {
        if (part.added) {
          process.stdout.write(chalk.green('+  ' + line) + '\n');
        } else if (part.removed) {
          process.stdout.write(chalk.red('-  ' + line) + '\n');
        } else {
          process.stdout.write(chalk.dim('   ' + line) + '\n');
        }
      });
  });
  process.stdout.write('\n');
}

function deepEqual() {
  try {
    assert.deepEqual.apply(assert.deepEqual, arguments);
  } catch (error) {
    if (_.isPlainObject(error.expected) && _.isPlainObject(error.actual)) {
      error.message = printDiff(diff.diffJson(error.expected, error.actual))
      delete error.expected;
      delete error.actual;
    }
    throw error;
  }
}

function convertQueryStringObject(obj) {
  if (!_.isPlainObject(obj)) return obj;
  return _.mapValues(obj, function(o) {
    if (_.isPlainObject(o)) {
      return convertQueryStringObject(o)
    }
    if (o === 'true') {
      return true
    }
    if (o === 'false') {
      return true
    }
    var num = _.toNumber(o)
    if (_.isNumber(num) && !_.isNaN(num)) {
      return num
    }
    return o
  })
}

Assertion.prototype.reply = function(status, responseBody, responseHeaders) {
  this.parseExpectedRequestBody();

  var self = this;

  this.app[this.method](this.path, function(req, res) {
    if(self.qs) {
      deepEqual(convertQueryStringObject(req.query), self.qs);
    }
    if(self.requestBody) {
      if(req.text) {
        deepEqual(req.text, self.requestBody);
      } else {
        deepEqual(req.body, self.requestBody);
      }
    }
    for(var name in self.headers) {
      deepEqual(req.headers[name], self.headers[name]);
    }

    if(responseHeaders) {
      res.set(responseHeaders);
    }

    var reply = function() {
        self.handler.emit("done");

        // Remove route from express since the expectation was met
        // Unless this mock is suposed to persist
        if (self.removeWhenMet) self.app._router.map[self.method].splice(req._route_index, 1);

        if (typeof responseBody === 'function') {
          res.status(status).send(responseBody(req));
        } else {
          res.status(status).send(responseBody);
        }

      };
    if(self.delay_ms) {
      setTimeout(reply, self.delay_ms);
    } else {
      reply();
    }
  });

  this.handler = new Handler(this);
  return this.handler;
}

function Handler(assertion) {
  this.defaults = {
    waitTimeout: 2000
  };
  var self = this;
  this.assertion = assertion;
  this.isDone = false;
  this.on("done", function() {
    self.isDone = true;
  });
}

util.inherits(Handler, EventEmitter);

Handler.prototype.done = function() {
  if(!this.isDone) {
    throw new Error(this.assertion.method + " " + this.assertion.path + " was not made yet.");
  }
}

Handler.prototype.wait = function(ms, fn) {
  if(!fn && typeof ms == "function") {
    fn = ms;
    ms = this.defaults.waitTimeout;
  }

  var self = this;
  var timeout = null;
  var cb = function() {
    clearTimeout(timeout);
    fn();
  }
  this.once("done", cb);
  timeout = setTimeout(function() {
    self.removeListener("done", cb);
    fn(new Error(self.assertion.method + " " + self.assertion.path + " was not called within " + ms + "ms."));
  }, ms);
}
