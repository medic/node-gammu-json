
var path = require('path'),
    async = require('async'),
    _ = require('underscore'),
    jsdump = require('jsDump'),
    moment = require('moment'),
    child = require('child_process');

/**
 * @namespace node-gammu-json:
 */
exports.prototype = {

    /**
     * @name _module_name:
     */
    _module_name: 'node-gammu-json',

    /**
     * @name _all_events:
     *   An associative array (read: object) containing all available
     *   event names as keys, and a unique number for each as values.
     */
    _all_events: {
      receive : 1, transmit: 2, error: 3,
      receive_segment: 4, return_segments: 5, release_segments: 6
    },

    /**
     * @name _debug_print:
     */

    _debug_print: function () {

      if (!this._debug_enabled) {
        return;
      }

      var skip_quote = false;
      var args = _.toArray(arguments);

      process.stderr.write(this._module_name + ':');

      for (var i = 0, len = args.length; i < len; ++i) {

        if (args[i] === String || args === Number) {
          skip_quote = true;
          continue;
        }

        process.stderr.write(' ');

        if (skip_quote && (_.isString(args[i]) || _.isNumeric(args[i]))) {
          skip_quote = false;
          process.stderr.write(args[i]);
        } else {
          process.stderr.write(
            jsdump.parse(args[i]).replace(/[\r\n\t\s]+/g, ' ')
          );
        }
      }

      process.stderr.write('\n');
      return this;
    },

    /**
     * @name _setenv:
     *   Set environment variable using a callback.
     */
    _setenv: function (_key, _callback) {

      process.env[_key] = _callback(process.env[_key])
    },

    /**
     * @name _start_polling:
     */
    _start_polling: function () {

      this._is_polling = true;
      this._handle_polling_timeout();

      return this;
    },

    /**
     * @name _stop_polling:
     */
    _stop_polling: function () {

      this._is_polling = false;
    },


    /**
     * @name _handle_polling_timeout:
     */
    _handle_polling_timeout: function () {

      var self = this;

      /* Check for termination:
          This is set via the `_stop_polling` method, above. */

      if (!self._is_polling) {
        self._debug_print('termination request received');
        return false;
      }

      /* Queue processing:
          Send messages, receive messages, then schedule next run.
          We make sure to always run each phase, regardless of error. */

      async.waterfall([

        function (_next_fn) {

          /* Phase one: receive messages */
          self._debug_print(String, 'receiving messages');

          self._receive_messages(function (_err) {

            if (_err) {
              self._notify_global_error(_err);
            }

            self._debug_print(String, 'receive finished');
            _next_fn();
          });
        },

        function (_next_fn) {

          /* Phase two: delete delivered messages */
          self._debug_print(String, 'deleting messages');

          self._delete_messages(function (_err) {

            if (_err) {
              self._notify_global_error(_err);
            }

            self._debug_print(String, 'delete finished');
            _next_fn();
          });
        },

        function (_next_fn) {

          /* Phase three: transmit messages */
          self._debug_print(String, 'transmitting messages');

          self._transmit_messages(function (_err) {

            if (_err) {
              self._notify_global_error(_err);
            }

            self._debug_print(String, 'transmit finished');
            _next_fn();
          });
        }

      ], function (_err) {

        self._debug_print(String, 'rescheduling');

        setTimeout(
          _.bind(self._handle_polling_timeout, self),
            self._poll_interval
        );
      });

      return true;
    },

    /**
     * @name _create_message_transmission_args:
     *   Return an array of interleaved phone numbers and message bodies,
     *   suitable for transmission using the `gammu-json` `send` command.
     *   These are command-line arguments for now, but might be sent via
     *   `stdin` instead once `gammu-json` actually supports it.
     */
    _create_message_transmission_args: function (_messages) {

      var rv = [];

      for (var i = 0, len = _messages.length; i < len; ++i) {

        if (this._transmit_batch_size <= i + 1) {
          break;
        }

        rv.push(_messages[i].to);
        rv.push(_messages[i].content);
      }

      return rv;
    },

    /**
     * @name _transmit_messages:
     */
    _transmit_messages: function (_callback) {

      var self = this;

      if (self._outbound_queue.length <= 0) {
        return _callback();
      }

      var args = [ 'send' ].concat(
        self._create_message_transmission_args(self._outbound_queue)
      );

      self._subprocess('gammu-json', args, function (_err, _rv) {

        if (_err) {
          return _callback(_err);
        }

        self._deliver_transmit_results(_rv, _callback);
      });
    },

    /**
     * @name _deliver_transmit_results:
     */
    _deliver_transmit_results: function (_results, _callback) {

      var self = this;
      var sent_indices = {};

      async.each(_results,

        function (_r, _next_fn) {

          /* Map result back to message:
              The `create_message_transmission_args` function guarantees
              that it will process the outbound queue in order, from offset
              zero onward. Because of this, the (one-based) index of the
              transmission result object will always imply the (zero-based)
              index of its corresponding message object in the outgoing queue. */

          var queue_index = _r.index - 1;
          var message = self._outbound_queue[queue_index];

          /* Check for success:
              Currently, we retry the whole message if any one segment
              fails. This isn't ideal; we should only retry untransmitted
              parts. To do this, `gammu-json` would need to be modified. */

          if (_r.result != 'success') {

            var limit = self._tx_attempt_limit;
            var attempts = (message.tx_attempts || 1);

            if (!limit || attempts < limit) {
              message.tx_attempts = attempts + 1;
            } else {
              self._notify_transmit_error(
                new Error('Failed to transmit'), message
              );
            }

            return _next_fn();
          }

          /* Notify client of successful transmission:
              This is different than the receive case, since we can't
              unsend the already-transmitted message. Thus, there's no
              possible error to check here, and we just continue on. */

          sent_indices[queue_index] = true;
          self._notify_transmit(message, _r);

          _next_fn();
        },

        function (_err) {

          /* Finish up:
              Replace the outbound queue with the messages we didn't
              transmit successfully; the next queue run will retry. */

          self._outbound_queue = _.reject(
            self._outbound_queue, function (_msg, _i) {
              return sent_indices[_i];
            }
          );

          return _callback();
        }
      );
    },

    /**
     * @name _transform_received_message:
     */
    _transform_received_message: function (_m) {

      if (_m.total_segments > 1) {
        _m.id = [ _m.from, (_m.udh || 0), _m.total_segments ].join('-');
      }

      if (_m.timestamp) {
        _m.timestamp = moment(_m.timestamp);
      }

      return this;
    },

    /**
     * @name _receive_messages:
     */
    _receive_messages: function (_callback) {

      var self = this;

      self._segment_cache = {};
      var reassembly_index = {};

      self._subprocess('gammu-json', [ 'retrieve' ], function (_err, _rv) {

        if (_err) {
          return _callback(_err);
        }

        /* For each incoming message:
            Each message is processed concurrently so I/O can overlap. */

        async.each(_rv,

          function (_message, _next_fn) {

            self._debug_print(String, 'receiving', _message);

            try {
              self._transform_received_message(_message);
            } catch (_e) {
              self._debug_print(String, 'message transform error', _e);
              return _next_fn(_e, _message);
            }

            /* Single-part message:
                This is easy; add it to the queue and bail out early. */

            if (_message.total_segments <= 1) {
              self._inbound_queue.push(_message);
              self._debug_print(String, 'queued single-segment message');
              return _next_fn();
            }

            /* Multi-part message:
                This is a bit trickier -- we keep track of message segments
                that we've already used in a prior successful reassembly;
                we then use this information to avoid double-delivery of a
                message (e.g. reassembling `[ A, B ]` *and* `[ B, A ]`). */

            async.waterfall([

              function (_fn) {

                self._notify_receive_segment(_message, _fn);
              },

              function (_should_delete, _fn) {

                if (self._message_index_lookup(_message, reassembly_index)) {
                  return _fn();
                }

                /* Schedule for deletion:
                    If we get here, then our instansiator successfully
                    wrote this message segment to persistent storage. */

                if (_should_delete) {
                  self._debug_print(String, 'scheduling deletion');
                  self._schedule_message_for_deletion(_message);
                }

                /* Otherwise, try to reassemble:
                    If the message is successfully reassembled here, then
                    `_m` will be the fully reassembled message, and `_e`
                    will be null. If both `_m` and `_e` are null, then we
                    don't yet have all of the necessary message segments. */

                self._debug_print(String, 'attempting reassembly');

                self._try_to_reassemble_message(_message, function (_e, _m) {

                  if (_m) {
                    self._inbound_queue.push(_m);
                    self._message_index_add(_m, reassembly_index);
                  }

                  _fn(_e);
                });
              }

            ], function (_e) {

              /* Item finished:
                  Deliver a receive error if there was one, and report
                  back to `async.each` that we've completed processing. */

              if (_e) {
                self._debug_print(String, 'receive error');
                self._notify_receive_error(_e, _message);
              }

              self._debug_print(String, 'finished');
              return _next_fn();
            });
          },

          function (_err) {

            /* All messages finished:
                Deliver an error if there was one, then proceed on
                to deliver all messages that are in the inbound spool . */

            if (_err) {
              return _callback(_err);
            }

            self._debug_print(String, 'delivering incoming messages');
            self._deliver_incoming_messages(_callback);
          }
        );
      });
    },

    /**
     * @name _deliver_incoming_messages:
     */
    _deliver_incoming_messages: function (_callback) {

      var self = this;

      async.each(self._inbound_queue,

        function (_message, _next_fn) {
          self._notify_receive(_message, function (_err) {

            /* Error status:
                If our instansiator reports an error in delivery, the
                message is still on the device. Just forget about it for
                the time being; we'll end up right back here during the
                next delivery, and will see the same message again. Since
                our instansiator was the one who rejected the message,
                the error is already known; don't send an error event. */

            if (_err) {
              return _next_fn();
            }

            /* Successful delivery:
                The message now belongs to someone else, who has confirmed
                that it's now written to an appropriate persistent storage
                device. Add any segments that haven't yet been deleted to
                the deletion queue; they're removed in `_delete_messages`. */

            self._schedule_message_for_deletion(_message);
            _next_fn();
          });
        },
        function (_err) {

          if (_err) {
            return _callback(_err);
          }

          /* Finish up:
              Replace the inbound queue with the empty array;
              all messages are either scheduled for deletion or
              will remain on the device until the next delivery. */

          self._inbound_queue = [];
          self._debug_print(String, 'incoming messages delivered');

          return _callback();
        }
      );
    },

    /**
     * @name _create_message_deletion_args:
     *   Return an array of location numbers from the deletion queue,
     *   suitable for use with the `gammu-json` `delete` command.
     *   These are command-line arguments for now, but might be sent
     *    via `stdin` instead once `gammu-json` actually supports it.
     */
    _create_message_deletion_args: function (_deletion_index) {

      var rv = [], i = 0;

      for (var k in _deletion_index) {

        if (this._delete_batch_size <= i + 1) {
          break;
        }

        rv.push(k);
        i++;
      }

      return rv;
    },

    /**
     * @name _message_index_add:
     */
    _message_index_add: function (_message, _index) {

      var locations = _message.location;

      if (!_.isArray(locations)) {
        locations = [ locations ];
      }

      for (var i = 0, len = locations.length; i < len; ++i) {
        _index[locations[i]] = _message;
      }
    },

    /**
     * @name _message_index_lookup:
     */
    _message_index_lookup: function (_message, _index) {

      return _index[_message.location];
    },

    /**
     * @name _schedule_message_for_deletion:
     */
    _schedule_message_for_deletion: function (_message) {

      this._message_index_add(_message, this._deletion_index);
      _message.location = false;
    },

    /**
     * @name _delete_messages:
     */
    _delete_messages: function (_callback) {

      var self = this;

      var undeleted_messages = {};
      var deletion_index = self._deletion_index;

      if (_.isEmpty(deletion_index)) {
        return _callback();
      }

      var args = [ 'delete' ].concat(
        self._create_message_deletion_args(deletion_index)
      );

      self._subprocess('gammu-json', args, function (_err, _rv) {

        if (_err) {
          return _callback(_err);
        }

        for (var i in deletion_index) {

          var message = deletion_index[i];

          if (_rv.detail[i] != 'ok') {
            self._message_index_add(message, undeleted_messages);
          }
        }

        self._deletion_index = undeleted_messages;
        return _callback();
      });
    },

    /**
     * @name _notify_global_error:
     */
    _notify_global_error: function (_error, _message) {

      var fn = this._handlers.error;

      this._debug_print(
        String, 'global error:', _error, _message
      );

      if (fn) {
        _error.scope = 'global';
        fn.call(this, _error, _message);
      }
    },

    /**
     * @name _notify_transmit:
     *   Invoke events appropriately for a successfully-transmitted
     *   message. The `_message` argument is the original pre-send
     *   message object (from the outbound queue); `_result` is the
     *   object that `gammu-json` yielded after the message was sent.
     *   Since a message cannot be un-sent, we neither include (nor
     *   wait for) a callback in this case.
     */
    _notify_transmit: function (_message, _result) {

      var fn = this._handlers.transmit;

      if (_.isFunction(_message.callback)) {
        _message.callback.call(this, null, _message, _result);
      }

      if (fn) {
        fn.call(this, _message, _result);
      }

      if (_message.id) {
        self._notify_release_segments(_message.id);
      }
    },

    /**
     * @name _notify_release_segments:
     *   Inform our instansiator that we no longer need any of the
     *   stored message segments for the message identified by `_id`.
     *   This event will typically only be handled if you're also
     *   also handling both `receive_segment` and `return_segments`.
     */
    _notify_release_segments: function (_id) {

      var fn = this._handlers.release_segments;

      if (fn) {
        fn.call(this, _id);
      }
    },

    /**
     * @name _notify_receive:
     *   Invoke events appropriately for a completely-received message.
     *   The `_message` argument is the received message object (from the
     *   inbound queue). If delivery fails in the event handler we're
     *   dispatching to, and that event handler's owner wants us to retry
     *   later (say, because that owner is out of storage space), then that
     *   handler *must* call `_callback` with a node-style error argument.
     *   Otherwise, the event handler should call `_callback` with a null or
     *   not-present first argument, and we'll consider the message to be
     *   delivered and no longer be our responsibility.
     */
    _notify_receive: function (_message, _callback) {

      var fn = this._handlers.receive;

      /* No receive handler?
          Trigger a global error event directly. This allows us to
          easily tell the difference between (a) the legitimate rejection
          of a message by `_callback`, and (b) this missing-handler case. */

      if (!fn) {
        var e = new Error('No event handler available for `receive`');
        this._notify_global_error(e);
        return _callback(e);
      }

      fn.call(this, _message, _callback);
    },

    /**
     * @name _notify_receive_segment:
     *   Invoke events appropriately when a single segment of a multi-part
     *   message arrives. As in `_notify_receive`, the handler of this event
     *   is supplied with a callback function; once it has stored the
     *   message segment on some form of reliable persistent storage, the
     *   callback should be invoked with no arguments, other than a normal
     *   node-style error parameter.
     *
     *   After the event is dispatched and our instansiator returns control
     *   to us, we will invoke `_callback` with two arguments -- the first
     *   will be a usual node-style error argument, and the second will be a
     *   boolean value indicating whether or not a handler was actually
     *   present and invoked (true if invoked; false if no handler was
     *   registered at the time `_notify_receive_segment` was called.
     *
     *   A missing handler isn't an error condition; it just means that we
     *   need to retain message parts on the modem itself until reassembly
     *   can be completed. It is however *recommended* that you handle this
     *   event, since many SMS modems have a small amount of storage and
     *   would be vulnerable to denial-of-service attacks (e.g. by
     *   deliberately sending a large number of multi-part messages with a
     *   segment omitted).
     */
    _notify_receive_segment: function (_message, _callback) {

      var fn = this._handlers.receive_segment;

      if (!fn) {
        return this._default_receive_segment(_message, function (_err) {
          return _callback(_err, false);
        });
      }

      fn.call(this, _message, function (_err) {
        _callback(_err, true);
      });
    },

    /**
     * @name _notify_receive_error:
     *   Invoke events appropriately when an error has occurred
     *   somewhere inside of the receive pipeline.
     */
    _notify_receive_error: function (_error, _message) {

      var fn = this._handlers.error;

      if (fn) {
        _error.scope = 'receive';
        fn.call(this, _error, _message);
      }
    },

    /**
     * @name _notify_transmit_error:
     *   Invoke events appropriately when an error has occurred
     *   somewhere inside of the message transmission pipeline.
     */
    _notify_transmit_error: function (_error, _message) {

      var fn = this._handlers.error;

      if (_.isFunction(_message.callback)) {
        _message.callback.call(this, _error, _message);
      }

      if (fn) {
        _error.scope = 'transmit';
        fn.call(this, _error, _message);
      }
    },

    /**
     * @name _request_return_segments:
     *   Request an array of previously-delivered "matching segments" from
     *   our instansiator. A "matching segment" is a message that has a
     *   `total_segments` greater than one, and has an `id` property that
     *   matches the `_id` argument supplied to us. These segments will have
     *   been previously sent to our instansiator via the `receive_segment`
     *   event. The `return_segments` event is invoked only when
     *   reassembling multi-part messages; it allows for different storage
     *   methods to be "plugged in" at any time. This approach can avoid the
     *   need for an application to maintain multiple data stores.
     *
     *   We provide a callback to the handler of this event. Once the
     *   appropriate message segments have been brought back in to main
     *   memory, and the caller is ready to transfer control back to us, the
     *   callback should invoked. Its first argument must be a node-style
     *   error argument (or null if no error occurred); its second argument
     *   must be an array of message objects with identifiers that match
     *   our `_id` parameter. The second argument is ignored if the first
     *   argument indicates an error.
     *
     *   When control is transferred back to us, we invoke `_callback` with
     *   three arguments: a node-style error argument, followed by an array
     *   of matching message objects (or `[]` if no matches were found),
     *   followed by a boolean value indicating whether or not a handler was
     *   present at the time `_request_return_segments` was called.
     */
    _request_return_segments: function (_id, _callback) {

      var fn = this._handlers.return_segments;

      if (!fn) {
        return this._default_return_segments(_id, function (_e, _rv) {
          return _callback(_e, _rv, false);
        });
      }

      fn.call(this, _id, function (_err, _messages) {
        return _callback(_err, _messages, true);
      });
    },

    /**
     * @name _default_receive_segment:
     */
    _default_receive_segment: function (_message, _callback) {

      var id = _message.id;

      if (!this._segment_cache[id]) {
        this._segment_cache[id] = [];
      }

      this._segment_cache[id].push(_message);
      return _callback();
    },

    /**
     * @name _default_return_segments:
     */
    _default_return_segments: function (_id, _callback) {

      return _callback(null, this._segment_cache[_id]);
    },

    /**
     * @name _try_to_reassemble_message:
     *  Asynchronously trigger our instansiator's `return_segments` handler,
     *  then attempt to completely reassemble `_message` using what that
     *  event handler returned to us. If we're able to, yield the (now fully
     *  reassembled) message back to our caller.  If we're not able to
     *  completely reassemble a message, we'll return control and wait for
     *  the next segment to come in. Upon finishing this process,
     *  `_callback` is invoked with a single node-style error argument.
     */
    _try_to_reassemble_message: function (_message, _callback) {

      var self = this;
      var rv = false;

      self._request_return_segments(_message.id, function (_err, _segments) {

        if (_err) {
          return _callback(_err);
        }

        if (_segments && !_.isArray(_segments)) {
          return _callback(
            new Error('Non-array yielded by `return_segments` event')
          );
        }

        try {
          var index = self._build_reassembly_index(_message, _segments);

          if (_.keys(index).length == _message.total_segments) {
            rv = self._create_message_from_reassembly_index(index);
          }
        } catch (_er) {
          return _callback(_er);
        }

        return _callback(null, rv);
      });
    },

    /**
     * @name _build_reassembly_index:
     *  Using `_message` (a single message segment) and `_segments` (a
     *  set of previously-received message segments), build an index to
     *  aid in message reassembly.  For each segment, we first make sure
     *  it has properties (e.g. `id` and `total_segments`) that are
     *  consistent with `_message`. Then, we hash each segment to quickly
     *  remove any duplicates and determine the quantity of segments
     *  present. We take care to ensure that, in the case of duplicates,
     *  the most recently-received part is used. This function does not
     *  determine whether all parts are present, nor does it actually
     *  perform reassembly -- it simply builds the data structure.
     */
    _build_reassembly_index: function (_message, _segments) {

      var rv = {};

      for (var i = 0, len = _segments.length; i < len; ++i) {
        this._add_to_reassembly_index(rv, _message, _segments[i]);
      }

      this._add_to_reassembly_index(rv, _message, _message);
      return rv;
    },

    /**
     * @name _add_to_reassembly_index:
     *   This function contains the actual validation and insertion
     *   logic for `_build_reassembly_index`. This function adds a
     *   single message segment `_m` to the reassembly index `_index`,
     *   after validating it against the reference message `_message`.
     *   Returns true if the message segment `_m` was valid; false
     *   otherwise. If an item with the same segment number already
     *   exists in the reassembly index and is newer than `_m`, this
     *   function will return true *without* modifying the index.
     */
    _add_to_reassembly_index: function (_index, _message, _m) {

      var total = _message.total_segments;

      var is_valid = (
        _.isObject(_m) && _m.id == _message.id &&
          _.isNumber(_m.segment) && _m.segment <= total &&
          _.isNumber(_m.total_segments) && _m.total_segments == total
      )

      if (!is_valid) {
        return false;
      }

      if (_index[_m.segment] != null) {
        if (_m.timestamp.isBefore(_index[_m.segment].timestamp)) {
          return true;
        }
      }

      _index[_m.segment] = _m;
      return true;
    },

    /**
     * @name: _create_message_from_reassembly_index:
     *   Produce a new fully-reassembled message object, using the
     *   message segments in the reassembly index `_index`. This
     *   function will not modify any of the message segments in
     *   `_index`, but *will* reference those message segments from the
     *   newly-created message object. This function is synchronous,
     *   and will either return the new message or throw an exception.
     */
    _create_message_from_reassembly_index: function (_index) {

      /* Start with first segment:
          The `_index` argument is an object, not an array; its keys
          are one-based segment numbers (rather than location numbers). */

      var first_message = _index[1];

      if (!_.isObject(first_message)) {
        throw new Error('Reassembly failed; index missing first entry');
      }

      var rv = _.clone(first_message);

      rv.id = false;
      rv.location = [];
      rv.segment = false;

      rv.parts = [ first_message ];
      rv.timestamp = first_message.timestamp;
      rv.smsc_timestamp = first_message.smsc_timestamp;
      rv.location.push(first_message.location);

      for (var i = 2; i <= rv.total_segments; ++i) {

        var segment = _index[i];

        if (!_.isObject(segment)) {
          throw new Error('Reassembly failed; index is missing an entry');
        }

        /* Concatenated SMS */
        rv.content += segment.content;

        /* Keep references to each part */
        rv.parts.push(segment);

        /* Use a list of locations when deleting */
        rv.location.push(segment.location);

        /* Use latest timestamp */
        for (var k in { timestamp: 0, smsc_timestamp: 1 }) {
          if (rv[k] && rv[k].isBefore(segment[k])) {
            rv[k] = segment[k];
          }
        }
      }

      return rv;
    },

    /**
     * @name _register_single_event:
     */
    _register_single_event: function (_event, _callback) {

      if (!_.isFunction(_callback)) {
        throw new Error('Event callback must be a function');
      }

      if (!this._all_events[_event]) {
        throw new Error('Invalid event specified');
      }

      this._handlers[_event] = _callback;
      return this;
    },

    /**
     * @name initialize:
     */
    initialize: function (_options) {

      var self = this;
      var options = (_options || {});

      self._handlers = {};
      self._options = options;

      self._inbound_queue = [];
      self._outbound_queue = [];
      self._deletion_index = {};
      self._debug_enabled = !!self._options.debug;

      self._is_polling = false;
      self._is_processing = false;

      self._poll_interval = (
        _.isNumber(options.interval) ?
          (options.interval * 1000) : 5000 /* Milliseconds */
      );

      self._debug_print(String, 'initializing');

      /* Segment cache:
          If the `receive_segment` and `return_segments` events don't both
          have handlers, then we don't have any persistent storage other than
          what's on the modem itself. In this case, we provide default event
          handlers. The default handlers store messages in this cache for
          the lifetime of the receive and reassembly processes. When we
          lack these event handlers, we also don't delete message
          segments from the modem until they're used in a successful
          reassembly operation. Since message parts remain on the modem,
          this cache is cleared at the beginning of `_receive_messages`. */

      self._segment_cache = {};

      /* Transmit batch size:
          This is the highest number of outbound messages that will be
          provided to a single run of gammu-json. This is intended to
          avoid high receive latency and OS-level `argv` size limits. */

      self._transmit_batch_size = (
        options.transmit_batch_size || 64
      );

      /* Delete batch size:
          This has the same rationale as above, but for deletions. */

      self._delete_batch_size = (
        options.delete_batch_size || 1024
      );

      /* Retry limit:
          We will make this many attempts to send a message. If we
          aren't able to send the message within this constraint, we
          will trigger error events/callbacks and discard the message.
          A value of zero means "no limit"; this is not recommended. */

      self._tx_attempt_limit = (
        _.isNumber(options.max_transmit_attempts) ?
          options.max_transmit_attempts : 2
      );

      /* Caller-provided prefix:
          If provided, add $PREFIX/bin to the environment's $PATH. */

      if (self._options.prefix) {
        self._setenv('PATH', function (_value) {
          return (
            path.resolve(self._options.prefix, 'bin') +
              ':' + (_value || '')
          );
        });
      }

      /* Debug notification:
          Print a startup message if debugging is enabled. */

      self._debug_print(String, 'debugging is enabled');
      return self;
    },

    /**
     * @name start:
     *   Start sending/receiving messages.
     */
    start: function () {

      this._start_polling();
    },

    /**
     * @name stop:
     *   Stop sending/receiving messages.
     */
    stop: function () {

      this._stop_polling();
    },

    /**
     * @name send:
     *   Send a message to one or more recipients.
     */
    send: function (_to, _message, _transmit_callback) {

      /* Perform sanity checks:
          Arguments aren't vectorized; don't pass arrays in. */

      if (_transmit_callback && !_.isFunction(_transmit_callback)) {
        throw new Error('Callback, if provided, must be a function');
      }

      if (!_.isString(_to)) {
        throw new Error('Destination must be supplied as a string');
      }

      if (!_.isString(_message)) {
        throw new Error('Message text must be supplied as a string');
      }

      /* Push on to work queue:
          This queue is consumed by `_transmit_messages`. */

      this._outbound_queue.push({
        to: _to, tx_attempts: 0,
        content: _message, callback: _transmit_callback
      });

      return this;
    },

    /**
     * @name on:
     *   Register an event-handling callback function. Valid events are
     *   `receive` (for being notified of single-part and fully-reassembled
     *   messages); `transmit` (for being notified of when a sent message
     *   has been successfully handed off to the telco for further
     *   transmission); `receive_segment` (for being notified of the receipt
     *   of each individual segment of a multi-part/concatenated message);
     *   and `return_segments` (invoked during message reassembly if any
     *   previously-received message segments are needed to drive the
     *   reassembly process).
     *
     *   To obtain full support for multi-part message reassembly, you *must*
     *   handle both the `receive_segment` and `return_segments` events. The
     *   `receive_segment` callback must write the message segment to
     *   persistent storage before returning; the `return_segments` callback
     *   must fetch and return all previously-stored message segments for a
     *   given message identifier.
     *
     *   The `_event` argument may be either a string or an object. If the
     *   `_event` argument is provided as an object, then the `_callback`
     *   argument is ignored. If the `_event` argument is a string, then
     *   `_callback` must be an event-handling function.
     */
    on: function (_event, _callback) {

      if (_.isObject(_event)) {
        for (var name in _event) {
          this._register_single_event(name, _event[name]);
        }
      } else if (_.isString(_event)) {
        this._register_single_event(_event, _callback);
      } else {
        throw new Error('Event name has an invalid type');
      }

      return this;
    },

    /**
     * @name subprocess:
     *   Start a JSON-generating subprocess, wait for it to finish,
     *   and then return process's (parsed) output as an object.
     */
    _subprocess: function (_path, _argv, _options, _callback) {

      this._debug_print(
        String, 'executing', _path, String, 'with arguments', _argv
      );

      var json = '', errors = '';
      var subprocess = child.spawn(_path, _argv, { stdio: 'pipe' });

      /* Fix up arguments:
          This allows `_options` to be optionally omitted. */

      if (!_callback) {
        _callback = _options;
        _options = {};
      }

      subprocess.stdout.on('data', function (_buffer) {
        json += _buffer.toString();
      });

      subprocess.on('exit', function (_code, _signal) {

        var rv = false;

        if (_code != 0) {
          return _callback(
            new Error('Subprocess exited with non-zero status', _code)
          );
        }

        try {
          rv = JSON.parse(json);
        } catch (e) {
          return _callback(
            new Error('Subprocess produced invalid/incomplete JSON', e)
          );
        }

        return _callback(null, rv);
      });

      subprocess.stdin.end();
    }
};

/**
 * @name create:
 */
exports.create = function (/* ... */) {

  var klass = function (_arguments) {
    return this.initialize.apply(this, _arguments);
  };

  klass.prototype = _.extend({}, exports.prototype);
  return new klass(arguments);
};

/* vim: set ai ts=8 sts=2 sw=2 expandtab: */
