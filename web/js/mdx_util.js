/**
 * JavaScript port of mdx_util.c from the native simple_mdx_player.
 *
 * The routines operate purely on ArrayBuffer / Uint8Array instances and mimic
 * the exact control flow of the original C so that MXDRV can keep using the
 * same helpers when fed with browser provided data.
 */

const MDX_CHUNK_TYPE = {
  TITLE: 0,
  PDX_FILE_NAME: 1,
  MDX_BODY: 2,
};

function requireUint8Array(buffer, label) {
  if (!(buffer instanceof Uint8Array)) {
    throw new Error(`${label} must be Uint8Array`);
  }
}

function mdxSeekFileImage(mdxFileImage, chunkType) {
  requireUint8Array(mdxFileImage, 'mdxFileImage');
  const size = mdxFileImage.length;
  if (size === 0) return null;

  let ofsSrc = 0;

  if (chunkType === MDX_CHUNK_TYPE.TITLE) {
    return ofsSrc;
  }

  let c = 0;
  for (;;) {
    if (ofsSrc >= size) return null;
    c = mdxFileImage[ofsSrc++];
    if (c === 0x0d || c === 0x0a) break;
    if (c < 0x20 && c !== 0x09 && c !== 0x1b) {
      return null;
    }
  }
  if (ofsSrc >= size) return null;

  ofsSrc += ofsSrc & 1;
  if (ofsSrc >= size) return null;

  if (c !== 0x0d) {
    for (;;) {
      if (ofsSrc >= size) return null;
      if (mdxFileImage[ofsSrc++] === 0x0d) break;
    }
  }
  if (ofsSrc >= size) return null;

  for (;;) {
    if (ofsSrc >= size) return null;
    if (mdxFileImage[ofsSrc++] === 0x1a) break;
  }
  if (ofsSrc >= size) return null;

  if (chunkType === MDX_CHUNK_TYPE.PDX_FILE_NAME) {
    return ofsSrc;
  }

  for (;;) {
    if (ofsSrc >= size) return null;
    c = mdxFileImage[ofsSrc++];
    if (c === 0) break;
  }
  if (ofsSrc >= size) return null;

  if (chunkType === MDX_CHUNK_TYPE.MDX_BODY) {
    return ofsSrc;
  }

  return null;
}

function mdxGetTitle(mdxFileImage, titleBufferSize = 256) {
  requireUint8Array(mdxFileImage, 'mdxFileImage');
  if (titleBufferSize <= 0) {
    throw new Error('titleBufferSize must be > 0');
  }
  const ofs = mdxSeekFileImage(mdxFileImage, MDX_CHUNK_TYPE.TITLE);
  if (ofs === null) return null;

  const end = mdxFileImage.length;
  let src = ofs;
  const bytes = [];
  while (true) {
    if (bytes.length >= titleBufferSize - 1) return null;
    if (src >= end) return null;
    const c = mdxFileImage[src++];
    if (c === 0x0d || c === 0x0a) break;
    if (c < 0x20 && c !== 0x09 && c !== 0x1b) return null;
    bytes.push(c);
  }
  return new TextDecoder('shift_jis').decode(new Uint8Array(bytes));
}

function mdxHasPdxFileName(mdxFileImage) {
  requireUint8Array(mdxFileImage, 'mdxFileImage');
  const ofs = mdxSeekFileImage(mdxFileImage, MDX_CHUNK_TYPE.PDX_FILE_NAME);
  if (ofs === null) return null;
  return mdxFileImage[ofs] !== 0;
}

function mdxGetPdxFileName(mdxFileImage) {
  requireUint8Array(mdxFileImage, 'mdxFileImage');
  const ofs = mdxSeekFileImage(mdxFileImage, MDX_CHUNK_TYPE.PDX_FILE_NAME);
  if (ofs === null) return null;
  if (mdxFileImage[ofs] === 0) return null;
  const bytes = [];
  let idx = ofs;
  let foundTerminator = false;
  while (idx < mdxFileImage.length) {
    const c = mdxFileImage[idx++];
    if (c === 0) {
      foundTerminator = true;
      break;
    }
    bytes.push(c);
  }
  if (!foundTerminator) return null;
  let pdxName = new TextDecoder('shift_jis').decode(new Uint8Array(bytes));
  if (!/\.pdx$/i.test(pdxName)) {
    pdxName += '.PDX';
  }
  return pdxName;
}

function mdxGetRequiredBufferSize(mdxFileImage, pdxFileImageSize = 0) {
  requireUint8Array(mdxFileImage, 'mdxFileImage');
  const mdxBodyOffset = mdxSeekFileImage(mdxFileImage, MDX_CHUNK_TYPE.MDX_BODY);
  if (mdxBodyOffset === null) return null;
  const mdxBufferSize = mdxFileImage.length + 8;
  let pdxBufferSize = 0;

  const hasPdx = mdxHasPdxFileName(mdxFileImage);
  if (hasPdx === null) return null;
  if (hasPdx) {
    const pdxOfs = mdxSeekFileImage(mdxFileImage, MDX_CHUNK_TYPE.PDX_FILE_NAME);
    if (pdxOfs === null) return null;
    let nameLength = 0;
    let idx = pdxOfs;
    let foundTerminator = false;
    while (idx < mdxFileImage.length && mdxFileImage[idx++] !== 0) {
      nameLength++;
    }
    if (idx <= mdxFileImage.length && mdxFileImage[idx - 1] === 0) {
      foundTerminator = true;
    }
    if (!foundTerminator) return null;
    nameLength++;
    let pdxBodyOffset = 8 + nameLength;
    pdxBodyOffset += pdxBodyOffset & 1;
    pdxBufferSize = pdxBodyOffset + (pdxFileImageSize >>> 0);
  }
  return { mdxBufferSize, pdxBufferSize, mdxBodyOffset };
}

function mdxUtilCreateMdxPdxBuffer(options) {
  const {
    mdxFileImage,
    pdxFileImage,
    mdxBuffer,
    pdxBuffer,
  } = options;
  requireUint8Array(mdxFileImage, 'mdxFileImage');
  if (!(mdxBuffer instanceof Uint8Array)) {
    throw new Error('mdxBuffer must be Uint8Array');
  }
  mdxBuffer.fill(0);
  mdxBuffer.set(mdxFileImage, 8);
  const bodyOffset = mdxSeekFileImage(mdxFileImage, MDX_CHUNK_TYPE.MDX_BODY);
  if (bodyOffset === null) {
    throw new Error('MDX body not found');
  }
  const hasPdx = mdxHasPdxFileName(mdxFileImage);
  mdxBuffer[2] = hasPdx ? 0 : 0xff;
  mdxBuffer[3] = hasPdx ? 0 : 0xff;
  mdxBuffer[4] = (bodyOffset + 8) >> 8;
  mdxBuffer[5] = (bodyOffset + 8) & 0xff;

  if (pdxFileImage && pdxBuffer) {
    requireUint8Array(pdxFileImage, 'pdxFileImage');
    pdxBuffer.fill(0);
    let nameOfs = 8;
    let idx = mdxSeekFileImage(mdxFileImage, MDX_CHUNK_TYPE.PDX_FILE_NAME);
    if (idx === null) {
      throw new Error('PDX chunk missing');
    }
    let foundTerminator = false;
    while (nameOfs < pdxBuffer.length) {
      if (idx >= mdxFileImage.length) throw new Error('PDX name truncated');
      const c = mdxFileImage[idx++];
      pdxBuffer[nameOfs++] = c;
      if (c === 0) {
        foundTerminator = true;
        break;
      }
    }
    if (!foundTerminator) {
      throw new Error('PDX name does not fit in pdxBuffer');
    }
    if (nameOfs & 1) pdxBuffer[nameOfs++] = 0;
    const bodyOfs = nameOfs;
    if (bodyOfs + pdxFileImage.length > pdxBuffer.length) {
      throw new Error('pdxBuffer is too small');
    }
    pdxBuffer.set(pdxFileImage, bodyOfs);
    pdxBuffer[4] = bodyOfs >> 8;
    pdxBuffer[5] = bodyOfs & 0xff;
    const nameLen = bodyOfs - 8;
    pdxBuffer[6] = nameLen >> 8;
    pdxBuffer[7] = nameLen & 0xff;
  }
}

export {
  MDX_CHUNK_TYPE,
  mdxSeekFileImage,
  mdxGetTitle,
  mdxHasPdxFileName,
  mdxGetPdxFileName,
  mdxGetRequiredBufferSize,
  mdxUtilCreateMdxPdxBuffer,
};
