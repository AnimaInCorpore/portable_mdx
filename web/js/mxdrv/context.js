import { MxdrvContextImpl } from './context_internal.js';
import {
  X68SoundContext,
  X68SoundContext_Initialize,
  X68SoundContext_Terminate,
} from '../x68sound/context.js';

class MxdrvContext {
  constructor() {
    this.m_impl = null;
  }
}

function ensureContext(context) {
  if (!(context instanceof MxdrvContext)) {
    throw new Error('context must be MxdrvContext');
  }
}

function ensureImpl(impl) {
  if (!(impl instanceof MxdrvContextImpl)) {
    throw new Error('impl must be MxdrvContextImpl');
  }
}

function writeOut(outValue, value) {
  if (outValue && typeof outValue === 'object') {
    outValue.value = value;
  }
}

function MxdrvContextImpl_ResetMemoryPool(impl) {
  ensureImpl(impl);
  impl.resetMemoryPool();
}

function MxdrvContextImpl_ReserveMemory(impl, sizeInBytes) {
  ensureImpl(impl);
  return impl.reserveMemory(sizeInBytes);
}

function MxdrvContextImpl_ReleaseMemory(impl, sizeInBytes) {
  ensureImpl(impl);
  return impl.releaseMemory(sizeInBytes);
}

function MxdrvContextImpl_GetReservedMemoryPoolSize(impl) {
  ensureImpl(impl);
  return impl.getReservedMemoryPoolSize();
}

function MxdrvContext_GetOpmReg(context, regIndex, regValOut, updatedOut) {
  ensureContext(context);
  if (!context.m_impl) return false;

  const idx = regIndex & 0xff;
  writeOut(regValOut, context.m_impl.m_opmRegs[idx]);
  if (updatedOut && typeof updatedOut === 'object') {
    updatedOut.value = !!context.m_impl.m_opmRegsUpdated[idx];
    context.m_impl.m_opmRegsUpdated[idx] = false;
  }
  return true;
}

function MxdrvContext_GetFmKeyOn(context, channelIndex, currentKeyOnOut, logicalSumOut) {
  ensureContext(context);
  if (!context.m_impl) return false;
  if (channelIndex < 0 || channelIndex > 7) return false;

  writeOut(currentKeyOnOut, !!context.m_impl.m_keyOnFlagsForFm[channelIndex]);
  if (logicalSumOut && typeof logicalSumOut === 'object') {
    logicalSumOut.value = !!context.m_impl.m_logicalSumOfKeyOnFlagsForFm[channelIndex];
    context.m_impl.m_logicalSumOfKeyOnFlagsForFm[channelIndex] = false;
  }
  return true;
}

function MxdrvContext_GetPcmKeyOn(context, channelIndex, logicalSumOut) {
  ensureContext(context);
  if (!context.m_impl) return false;
  if (channelIndex < 0 || channelIndex > 7) return false;

  if (logicalSumOut && typeof logicalSumOut === 'object') {
    logicalSumOut.value = !!context.m_impl.m_logicalSumOfKeyOnFlagsForPcm[channelIndex];
    context.m_impl.m_logicalSumOfKeyOnFlagsForPcm[channelIndex] = false;
  }
  return true;
}

function MxdrvContext_EnterCriticalSection(context) {
  ensureContext(context);
  if (!context.m_impl) {
    throw new Error('context is not initialized');
  }
  context.m_impl.m_mtx.lock();
}

function MxdrvContext_LeaveCriticalSection(context) {
  ensureContext(context);
  if (!context.m_impl) {
    throw new Error('context is not initialized');
  }
  context.m_impl.m_mtx.unlock();
}

function MxdrvContext_Initialize(context, memoryPoolSizeInBytes) {
  ensureContext(context);
  context.m_impl = null;

  if (!Number.isInteger(memoryPoolSizeInBytes) || memoryPoolSizeInBytes <= 0) {
    return false;
  }

  let impl;
  try {
    impl = new MxdrvContextImpl(memoryPoolSizeInBytes);
  } catch {
    return false;
  }

  const x68SoundContext = new X68SoundContext();
  if (!X68SoundContext_Initialize(x68SoundContext, impl)) {
    return false;
  }

  impl.m_x68SoundContext = x68SoundContext;
  context.m_impl = impl;
  return true;
}

function MxdrvContext_Terminate(context) {
  ensureContext(context);
  if (!context.m_impl) return false;

  const impl = context.m_impl;
  const x68Context = impl.m_x68SoundContext;
  if (x68Context && !X68SoundContext_Terminate(x68Context)) {
    return false;
  }

  context.m_impl = null;
  return true;
}

export {
  MxdrvContext,
  MxdrvContextImpl_ResetMemoryPool,
  MxdrvContextImpl_ReserveMemory,
  MxdrvContextImpl_ReleaseMemory,
  MxdrvContextImpl_GetReservedMemoryPoolSize,
  MxdrvContext_GetOpmReg,
  MxdrvContext_GetFmKeyOn,
  MxdrvContext_GetPcmKeyOn,
  MxdrvContext_EnterCriticalSection,
  MxdrvContext_LeaveCriticalSection,
  MxdrvContext_Initialize,
  MxdrvContext_Terminate,
};
