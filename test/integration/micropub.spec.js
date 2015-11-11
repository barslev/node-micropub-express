/* jshint node: true, expr: true */
/* global beforeEach, afterEach, describe, it */

'use strict';

var chai = require('chai');
var chaiAsPromised = require('chai-as-promised');
var nock = require('nock');
var request = require('supertest');
var sinon = require('sinon');
var sinonChai = require('sinon-chai');

require('sinon-as-promised');

chai.use(chaiAsPromised);
chai.use(sinonChai);
chai.should();

describe('Micropub API', function () {
  var express = require('express');
  var micropub = require('../../');

  var app, agent, token, handlerStub;

  var mockTokenEndpoint = function (code, response) {
    return nock('https://tokens.indieauth.com/')
      .get('/token')
      .reply(
        code || 200,
        response || 'me=http%3A%2F%2Fkodfabrik.se%2F&scope=post',
        { 'Content-Type': 'application/x-www-form-urlencoded' }
      );
  };

  var doRequest = function (mock, done, code, content, response) {
    var req = agent
      .post('/micropub')
      .set('Authorization', 'Bearer ' + token);

    if (typeof content === 'function') {
      req = content(req);
    } else {
      req = req
        .type('form')
        .send(content || {
          h: 'entry',
          content: 'hello world',
        });
    }

    if (response) {
      req = req.expect(code || 201, response);
    } else {
      req = req.expect(code || 201);
    }

    if (!done) {
      return req;
    }

    req.end(function (err) {
      if (err) { return done(err); }
      if (mock) { mock.done(); }
      done();
    });
  };

  beforeEach(function () {
    nock.disableNetConnect();

    // Needed so that supertest can connect to its own temporary local servers
    // Without it things blows up in a not so easy to debug way
    nock.enableNetConnect('127.0.0.1');

    token = 'abc123';
    handlerStub = sinon.stub().resolves({
      url: 'http://example.com/new/post',
    });

    app = express();
    app.use('/micropub', micropub({
      handler: handlerStub,
      tokenReference: {
        me: 'http://kodfabrik.se/',
        endpoint: 'https://tokens.indieauth.com/token',
      },
    }));

    agent = request.agent(app);
  });

  afterEach(function () {
    nock.cleanAll();
  });

  describe('basics', function () {

    // it('should not accept a GET-request', function (done) {
    //   agent.get('/micropub').expect(405, done);
    // });

    it('should require authorization', function (done) {
      agent
        .post('/micropub')
        .expect(401, 'Missing "Authorization" header or body parameter.', done);
    });

  });

  describe('auth', function () {

    it('should call handler and return 201 on successful request', function (done) {
      var mock = nock('https://tokens.indieauth.com/')
        .matchHeader('Authorization', function (val) { return val && val[0] === 'Bearer ' + token; })
        .matchHeader('Content-Type', function (val) { return val && val[0] === 'application/x-www-form-urlencoded'; })
        .matchHeader('User-Agent', function (val) { return val && /^micropub-express\/[0-9.]+ \(http[^)]+\)$/.test(val); })
        .get('/token')
        .reply(
          200,
          'me=http%3A%2F%2Fkodfabrik.se%2F&issued_by=https%3A%2F%2Ftokens.indieauth.com%2Ftoken&client_id=http%3A%2F%2F127.0.0.1%3A8080%2F&issued_at=1435611612&scope=post&nonce=501574078',
          { 'Content-Type': 'application/x-www-form-urlencoded' }
        );

      doRequest(mock, done);
    });

    it('should return error on invalid token', function (done) {
      var mock = mockTokenEndpoint(400, 'error=unauthorized&error_description=The+token+provided+was+malformed');
      doRequest(mock, done, 403);
    });

    it('should return error on mismatching me', function (done) {
      var mock = mockTokenEndpoint(200, 'me=http%3A%2F%2Fvoxpelli.com%2F&scope=post');
      doRequest(mock, done, 403);
    });

    it('should return error on missing post scope', function (done) {
      var mock = mockTokenEndpoint(200, 'me=http%3A%2F%2Fkodfabrik.se%2F&scope=misc');
      doRequest(mock, done, 403);
    });

    it('should handle multiple scopes', function (done) {
      var mock = mockTokenEndpoint(200, 'me=http%3A%2F%2Fkodfabrik.se%2F&scope=post,misc');
      doRequest(mock, done);
    });

    it('should handle multiple token references', function (done) {
      app = express();
      app.use('/micropub', micropub({
        handler: handlerStub,
        tokenReference: function () {
          return [
            { endpoint: 'https://tokens.indieauth.com/token', me: 'http://kodfabrik.se/' },
            { endpoint: 'https://tokens.indieauth.com/token', me: 'http://example.com/' },
          ];
        },
      }));

      agent = request.agent(app);

      var mock = mockTokenEndpoint(200, 'me=http%3A%2F%2Fexample.com%2F&scope=post,misc');

      doRequest(mock, done);
    });

    it('should use custom user agent', function (done) {
      app = express();
      app.use('/micropub', micropub({
        handler: handlerStub,
        userAgent: 'foobar/1.0',
        tokenReference: {
          me: 'http://kodfabrik.se/',
          endpoint: 'https://tokens.indieauth.com/token',
        },
      }));

      agent = request.agent(app);

      var mock = nock('https://tokens.indieauth.com/')
        .matchHeader('User-Agent', function (val) { return val && /^foobar\/1\.0 micropub-express\/[0-9.]+ \(http[^)]+\)$/.test(val); })
        .get('/token')
        .reply(
          200,
          'me=http%3A%2F%2Fkodfabrik.se%2F&issued_by=https%3A%2F%2Ftokens.indieauth.com%2Ftoken&client_id=http%3A%2F%2F127.0.0.1%3A8080%2F&issued_at=1435611612&scope=post&nonce=501574078',
          { 'Content-Type': 'application/x-www-form-urlencoded' }
        );

      doRequest(mock, done);
    });

  });

  describe('create', function () {

    var mock;

    beforeEach(function () {
      mock = mockTokenEndpoint(200, 'me=http%3A%2F%2Fkodfabrik.se%2F&scope=post,misc');
    });

    it('should require h-field', function (done) {
      agent
        .post('/micropub')
        .set('Authorization', 'Bearer abc123')
        .expect(400, 'Missing "h" value.', function () {
          mock.done();
          done();
        });
    });

    it('should refuse update requests', function (done) {
      doRequest(mock, done, 501, { 'mp-action': 'edit' }, 'This endpoint does not yet support updates.');
    });

    it('should fail when no properties', function (done) {
      doRequest(mock, done, 400, {
        h: 'entry',
      });
    });

    it('should call handle on content', function (done) {
      doRequest()
        .expect('Location', 'http://example.com/new/post')
        .end(function (err) {
          if (err) { return done(err); }

          mock.done();

          handlerStub.should.have.been.calledOnce;
          handlerStub.firstCall.args.should.have.length(2);
          handlerStub.firstCall.args[0].should.deep.equal({
            type: ['h-entry'],
            properties: {
              content: ['hello world'],
            }
          });
          handlerStub.firstCall.args[1].should.be.an('object');

          done();
        });
    });

    it('should call handle on like-of', function (done) {
      doRequest(false, false, 201, {
        h: 'entry',
        'like-of': 'http://example.com/liked/post',
      })
        .expect('Location', 'http://example.com/new/post')
        .end(function (err) {
          if (err) { return done(err); }

          mock.done();

          handlerStub.callCount.should.equal(1);
          handlerStub.firstCall.args.should.have.length(2);
          handlerStub.firstCall.args[0].should.deep.equal({
            type: ['h-entry'],
            properties: {
              'like-of': ['http://example.com/liked/post'],
            }
          });
          handlerStub.firstCall.args[1].should.be.an('object');

          done();
        });
    });

    it('should handle totally random properties', function (done) {
      doRequest(false, false, 201, {
        h: 'entry',
        foo: '123',
      })
        .expect('Location', 'http://example.com/new/post')
        .end(function (err) {
          if (err) { return done(err); }

          mock.done();

          handlerStub.callCount.should.equal(1);
          handlerStub.firstCall.args.should.have.length(2);
          handlerStub.firstCall.args[0].should.deep.equal({
            type: ['h-entry'],
            properties: {
              'foo': ['123'],
            }
          });
          handlerStub.firstCall.args[1].should.be.an('object');

          done();
        });
    });

    it('should call handle on HTML content', function (done) {
      doRequest(false, false, 201, {
        h: 'entry',
        'content[html]': '<strong>Hi</strong>',
      })
        .expect('Location', 'http://example.com/new/post')
        .end(function (err) {
          if (err) { return done(err); }

          mock.done();

          handlerStub.should.have.been.calledOnce;
          handlerStub.firstCall.args.should.have.length(2);
          handlerStub.firstCall.args[0].should.deep.equal({
            type: ['h-entry'],
            properties: {
              content: [{
                html: '<strong>Hi</strong>',
              }],
            }
          });
          handlerStub.firstCall.args[1].should.be.an('object');

          done();
        });
    });

    it('should call handle on JSON payload', function (done) {
      doRequest(undefined, undefined, undefined, function (req) {
        return req.type('json').send({
          type: ['h-entry'],
          properties: {
            content: ['hello world'],
          },
        });
      })
        .expect('Location', 'http://example.com/new/post')
        .end(function (err) {
          if (err) { return done(err); }

          mock.done();

          handlerStub.callCount.should.equal(1);
          handlerStub.firstCall.args.should.have.length(2);
          handlerStub.firstCall.args[0].should.deep.equal({
            type: ['h-entry'],
            properties: {
              content: ['hello world'],
            }
          });
          handlerStub.firstCall.args[1].should.be.an('object');

          done();
        });
    });

    it('should call handle on multipart payload', function (done) {
      doRequest(undefined, undefined, undefined, function (req) {
        return req
          .field('h', 'entry')
          .field('content', 'hello world');
      })
        .expect('Location', 'http://example.com/new/post')
        .end(function (err) {
          if (err) { return done(err); }

          mock.done();

          handlerStub.should.have.been.calledOnce;
          handlerStub.firstCall.args.should.have.length(2);
          handlerStub.firstCall.args[0].should.deep.equal({
            type: ['h-entry'],
            properties: {
              content: ['hello world'],
            }
          });
          handlerStub.firstCall.args[1].should.be.an('object');

          done();
        });
    });

    it('should transform mp-* properties', function (done) {
      doRequest(false, false, 201, {
        h: 'entry',
        'mp-foo': 'bar',
        'like-of': 'http://example.com/liked/post',
      })
        .expect('Location', 'http://example.com/new/post')
        .end(function (err) {
          if (err) { return done(err); }

          mock.done();

          handlerStub.callCount.should.equal(1);
          handlerStub.firstCall.args.should.have.length(2);
          handlerStub.firstCall.args[0].should.deep.equal({
            type: ['h-entry'],
            properties: {
              'like-of': ['http://example.com/liked/post'],
            },
            mp: {
              foo: ['bar'],
            },
          });
          handlerStub.firstCall.args[1].should.be.an('object');

          done();
        });
    });

    it('should transform mp-* properties in JSON payload', function (done) {
      doRequest(undefined, undefined, undefined, function (req) {
        return req.type('json').send({
          type: ['h-entry'],
          'mp-foo': 'bar',
          properties: {
            content: ['hello world'],
          },
        });
      })
        .expect('Location', 'http://example.com/new/post')
        .end(function (err) {
          if (err) { return done(err); }

          mock.done();

          handlerStub.callCount.should.equal(1);
          handlerStub.firstCall.args.should.have.length(2);
          handlerStub.firstCall.args[0].should.deep.equal({
            type: ['h-entry'],
            properties: {
              content: ['hello world'],
            },
            mp: {
              foo: ['bar'],
            },
          });
          handlerStub.firstCall.args[1].should.be.an('object');

          done();
        });
    });


  });

});
