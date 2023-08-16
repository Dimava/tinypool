import { stderr, stdout } from 'src/utils'
import {
  ReadyMessage,
  RequestMessage,
  ResponseMessage,
  StartupMessage,
  TinypoolWorkerMessage,
} from '../common'
import { getHandler, throwInNextTick } from './utils'

type IncomingMessage =
  | (StartupMessage & TinypoolWorkerMessage<'pool'>)
  | (RequestMessage & TinypoolWorkerMessage<'port'>)

type OutgoingMessage =
  | (ReadyMessage & TinypoolWorkerMessage<'pool'>)
  | (ResponseMessage & TinypoolWorkerMessage<'port'>)

process.__tinypool_state__ = {
  isChildProcess: true,
  isTinypoolWorker: true,
  workerData: null,
  workerId: process.pid,
}

process.on('message', (message: IncomingMessage) => {
  // Message was not for port or pool
  // It's likely end-users own communication between main and worker
  if (!message || !message.__tinypool_worker_message__) return

  if (message.source === 'pool') {
    const { filename, name } = message

    ;(async function () {
      if (filename !== null) {
        await getHandler(filename, name)
      }

      process.send!(<OutgoingMessage>{
        ready: true,
        source: 'pool',
        __tinypool_worker_message__: true,
      })
    })().catch(throwInNextTick)

    return
  }

  if (message.source === 'port') {
    return onMessage(message).catch(throwInNextTick)
  }

  throw new Error(`Unexpected TinypoolWorkerMessage ${JSON.stringify(message)}`)
})

async function onMessage(message: IncomingMessage & { source: 'port' }) {
  const { taskId, task, filename, name } = message
  let response: OutgoingMessage & Pick<typeof message, 'source'>

  try {
    const handler = await getHandler(filename, name)
    if (handler === null) {
      throw new Error(`No handler function exported from ${filename}`)
    }
    const result = await handler(task)
    response = {
      source: 'port',
      __tinypool_worker_message__: true,
      taskId,
      result,
      error: null,
      usedMemory: process.memoryUsage().heapUsed,
    }

    // If the task used e.g. console.log(), wait for the stream to drain
    // before potentially entering the `Atomics.wait()` loop, and before
    // returning the result so that messages will always be printed even
    // if the process would otherwise be ready to exit.
    if (stdout()?.writableLength! > 0) {
      await new Promise((resolve) => process.stdout.write('', resolve))
    }
    if (stderr()?.writableLength! > 0) {
      await new Promise((resolve) => process.stderr.write('', resolve))
    }
  } catch (error) {
    response = {
      source: 'port',
      __tinypool_worker_message__: true,
      taskId,
      result: null,
      error: serializeError(error),
      usedMemory: process.memoryUsage().heapUsed,
    }
  }

  process.send!(response)
}

function serializeError(error: unknown) {
  if (error instanceof Error) {
    return {
      ...error,
      name: error.name,
      stack: error.stack,
      message: error.message,
    }
  }

  return String(error)
}
