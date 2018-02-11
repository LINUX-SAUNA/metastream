import log from 'browser/log'
import { NETWORK_TIMEOUT } from '../../../constants/network'

const EventEmitter = require('events').EventEmitter
const sodium = require('sodium-native')

// TODO: just use sodium-universal directly?
const enc = require('sodium-encryption')

const lpstream = require('length-prefixed-stream')
const SimplePeer = require('simple-peer')

const SUCCESS = new Buffer('chat-auth-success')

function pub2auth(publicKey) {
  const publicAuthKey = new Buffer(sodium.crypto_box_PUBLICKEYBYTES)
  sodium.crypto_sign_ed25519_pk_to_curve25519(publicAuthKey, publicKey)
  return publicAuthKey
}

function secret2auth(secretKey) {
  const secretAuthKey = new Buffer(sodium.crypto_box_SECRETKEYBYTES)
  sodium.crypto_sign_ed25519_sk_to_curve25519(secretAuthKey, secretKey)
  return secretAuthKey
}

function seal(msg, publicKey) {
  var cipher = new Buffer(msg.length + sodium.crypto_box_SEALBYTES)
  sodium.crypto_box_seal(cipher, msg, publicKey)
  return cipher
}

function unseal(cipher, publicKey, secretKey) {
  if (cipher.length < sodium.crypto_box_SEALBYTES) return null
  var msg = new Buffer(cipher.length - sodium.crypto_box_SEALBYTES)
  if (!sodium.crypto_box_seal_open(msg, cipher, publicKey, secretKey)) return null
  return msg
}

/**
 * Socket wrapper to use encrypted keypair communication
 */
export class EncryptedSocket extends EventEmitter {
  constructor(socket, publicKey, secretKey) {
    super()

    this.socket = socket
    this.publicKey = publicKey
    this.secretKey = secretKey

    this.publicAuthKey = pub2auth(publicKey)
    this.secretAuthKey = secret2auth(secretKey)

    this._onReceive = this._onReceive.bind(this)
    this._authTimeout = this._authTimeout.bind(this)
  }

  /**
   * Connect to peer
   * @param {*} hostKey If present, authenticate with the host
   * @param {*} initiator Whether this connection is initiating
   */
  connect(hostKey) {
    if (hostKey) {
      this._authHost(hostKey)
    } else {
      this._authPeer()
    }

    this._authTimeoutId = setTimeout(this._authTimeout, NETWORK_TIMEOUT)
  }

  _authTimeout() {
    this._authTimeoutId = null
    this._error(`Auth timed out`)
  }

  _setupSocket() {
    this._encode = lpstream.encode()
    this._decode = lpstream.decode()

    this._decode.on('data', this._onReceive)

    this._encode.pipe(this.socket)
    this.socket.pipe(this._decode)
  }

  _setupEncryptionKey(peerKey) {
    if (!this.sharedKey) {
      this.peerKey = peerKey
      this.peerAuthKey = pub2auth(peerKey)
      this.sharedKey = enc.scalarMultiplication(this.secretAuthKey, this.peerAuthKey)
      this._setupSocket()
    }
  }

  /** Auth connection to host */
  _authHost(hostKey) {
    const self = this

    /** 1. Send auth request with encrypted identity */
    function sendAuthRequest() {
      const box = seal(self.publicKey, self.peerAuthKey)

      // Send without shared key encryption until peer can derive it
      self.socket.write(box)

      self.once('data', receiveChallenge)
    }

    /** 2. Receive challenge to decrypt, send back decrypted */
    function receiveChallenge(challenge) {
      self.write(challenge)
      self.once('data', receiveAuthSuccess)
    }

    /** 3. Receive auth success */
    function receiveAuthSuccess(data) {
      if (data.equals(SUCCESS)) {
        self._onAuthed()
      }
    }

    this._setupEncryptionKey(hostKey)
    sendAuthRequest()
  }

  /** Auth connection to peer */
  _authPeer(socket, publicKey, secretKey) {
    const self = this

    let challenge

    /** 1. Learn peer identity */
    function receiveAuthRequest(data) {
      const buf = Buffer.from(data)
      const peerPublicKey = unseal(buf, self.publicAuthKey, self.secretAuthKey)

      if (!peerPublicKey) {
        self._error('Failed to unseal peer box')
        return
      }

      if (self.publicKey.equals(peerPublicKey)) {
        // console.error('Auth request key is the same as the host')
        // return
      }

      self._setupEncryptionKey(peerPublicKey)
      sendChallenge()
    }

    /** 2. Respond with challenge to decrypt */
    function sendChallenge() {
      challenge = enc.nonce()
      self.write(challenge)
      self.once('data', receiveChallengeVerification)
    }

    /** 3. Verify decrypted challenge */
    function receiveChallengeVerification(decryptedChallenge) {
      if (challenge.equals(decryptedChallenge)) {
        self.write(SUCCESS)
        self._onAuthed()
      } else {
        self._error('Failed to authenticate peer')
      }
    }

    this.socket.once('data', receiveAuthRequest)
  }

  _onAuthed() {
    if (this._authTimeoutId) {
      clearTimeout(this._authTimeoutId)
      this._authTimeoutId = null
    }

    this.emit('connection')
  }

  write(data) {
    if (!this.sharedKey) {
      throw new Error(`EncryptedSocket failed to write. Missing 'sharedKey'`)
    }

    const nonce = enc.nonce()
    const box = enc.encrypt(data, nonce, this.sharedKey)

    const msg = new Buffer(nonce.length + box.length)
    nonce.copy(msg)
    box.copy(msg, nonce.length)

    this._encode.write(msg)
    log.debug(`Write ${msg.length} to ${this.peerKey.toString('hex')}`)
  }

  _onReceive(data) {
    if (!this.sharedKey) {
      throw new Error(`EncryptedSocket failed to receive. Missing 'sharedKey'`)
    }

    log.debug(`Received ${data.length} from ${this.peerKey.toString('hex')}`)

    const nonce = data.slice(0, sodium.crypto_box_NONCEBYTES)
    const box = data.slice(sodium.crypto_box_NONCEBYTES, data.length)

    const msg = enc.decrypt(box, nonce, this.sharedKey)

    if (!msg) {
      throw new Error('EncryptedSocket failed to decrypt received data.')
    }

    this.emit('data', msg)
  }

  destroy() {
    if (this.socket) {
      this.socket.destroy()
      this.socket = null
    }
    this.emit('close')
  }

  _error(err) {
    log.error(`[EncryptedSocket]`, err)
    this.destroy()
    this.emit('error', err)
  }
}
