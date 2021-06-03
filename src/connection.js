import SP from 'serialport'
import net from 'net'

const connections = {}

async function list() {
  return (await SP.list()).map(x => (
    x.path = x.path || x.comName,
    x
  ))
}

export default async function Connection({
  idleTimeout = 10000,
  queryTimeout = 2000,
  retries = 5,
  path
} = {}) {
  path = typeof path === 'function'
    ? path(await list())
    : path
    || ((await list()).sort((a, b) => b.path.localeCompare(a.path)).find(x => x.path.match('usbserial|COM[0-9]|ttyUSB')) || {}).path

  if (path in connections)
    return connections[path]

  let queue = []

  const c = new SP(path)
      , header = Buffer.from([0xaa])

  let message = Buffer.alloc(0)
    , idleTimer
    , queryTimer
    , open = false
    , current

  c.on('open', () => {
    open = true
    next()
  })

  c.on('connect', () => {
    open = true
    next()
  })

  c.on('data', function ondata(x) {
    startIdleTimeout(idleTimer)

    message = Buffer.concat([message, x])

    if (!message[3] || message[3] > message.length - 5)
      return

    current && handle(message.slice(4, 4 + message[3]))
    message = message.slice(4 + message[3])
  })

  c.on('error', end)
  c.on('close', end)

  return connections[path] = ({
    close: () => c.close(),
    send(command, id, data) {
      return new Promise((resolve, reject) => {
        queue.push({ resolve, reject, command, id, data, retries })
        next()
      })
    }
  })

  function next() {
    open && queue.length && !current && write(current = queue.shift())
  }

  function startIdleTimeout() {
    clearTimeout(idleTimer)
    idleTimer = setTimeout(() => (end(new Error('Idle Timeout')), c.close()), idleTimeout)
  }

  function queryTimedOut() {
    if (!current)
      return

    current.retries-- > 0
      ? write(current)
      : (current.reject(new Error('Query Timed Out')), current = null)
  }

  function write(x) {
    startIdleTimeout()
    queryTimer = setTimeout(queryTimedOut, queryTimeout)
    message = Buffer.alloc(0)
    const body = Buffer.from([
      x.command,
      x.id,
      x.data.length,
      ...x.data
    ])

    c.write(Buffer.concat([
      header,
      body,
      checksum(body)
    ]), err => err ? x.reject(err) : (x.id === 0xfe && x.resolve()))
  }

  function checksum(x) {
    return Buffer.from([x.reduce((a, b) => a + b) % 256])
  }

  function handle(x) {
    clearTimeout(queryTimer)
    const [status, command, ...data] = x
    if (current.command !== command)
      current.reject('Wrong command in reply - got ' + hex(command) + ' expected ' + hex(current.command))
    else if (status === 0x41) // ack
      current.resolve(data)
    else
      current.reject(data)

    current = null
    next()
  }

  function hex(x) {
    return ('0' + x.toString(16)).slice(-2)
  }

  function end(err) {
    clearTimeout(idleTimer)
    current && current.reject(err)
    queue.forEach(x => x.reject(err))
    queue = []
    delete connections[path]
  }
}
