import {ToolOp, StringProperty} from '../path.ux/scripts/pathux.js'
import {DataRefProperty} from '../core/lib_api.js'
import {ImageBlock, ImageTypes} from './image.js'
import * as platform from '../core/platform.js'
import bus from '../core/bus.js'
import {ImageBus} from '../editors/image/ImageBus.js'

export class ImageOp extends ToolOp {
  static tooldef() {
    return {
      inputs: {
        //resolves to an ImageUser instance
        dataPath: new StringProperty('imageEditor.imageUser'),
      },
    }
  }

  getImage(ctx) {
    let iuser = ctx.api.getValue(ctx, this.inputs.dataPath.getValue())

    if (!iuser) {
      console.warn('Failed to look up image at path', this.inputs.dataPath.getValue())
    }

    return iuser
  }
}

export class LoadImageOp extends ImageOp {
  static tooldef() {
    return {
      uiname  : 'Open Image',
      toolpath: 'image.open',
      inputs: ToolOp.inherit({
        fileName: new StringProperty('unnamed'),
        dataURL : new StringProperty(),
      }),
      outputs: ToolOp.inherit({
        image: new DataRefProperty(ImageBlock),
      }),
      is_modal: true,
    }
  }

  modalStart(ctx) {
    super.modalStart(ctx)
    this.modalEnd(false)

    let filename

    platform.platform
      .showOpenDialog('Open File', {
        filters: [
          {
            name      : 'Images',
            extensions: ['png', 'jpg', 'tiff', 'bmp', 'gif', 'tga'],
          },
        ],
      })
      .then((paths) => {
        console.log('paths', paths)
        if (paths.length === 0) {
          return
        }

        filename = paths[0].filename

        return platform.platform.readFile(paths[0], 'application/x-octet-stream')
      })
      .then((buffer) => {
        let mime = platform.getMime(filename)
        console.log('got data!', buffer, filename, mime)

        let u8 = new Uint8Array(buffer)
        let s = ''

        for (let i = 0; i < u8.length; i++) {
          s += String.fromCharCode(u8[i])
        }
        s = btoa(s)

        let url = `data:${mime};base64,${s}`

        this.inputs.fileName.setValue(filename)
        this.inputs.dataURL.setValue(url)

        this.exec(ctx)
      })
  }

  exec(ctx) {
    let filename = this.inputs.fileName.getValue()
    let datapath = this.inputs.dataPath.getValue()
    let url = this.inputs.dataURL.getValue()

    let image = new ImageBlock()
    image.name = filename
    image.type = ImageTypes.URL
    image.url = url

    ctx.datalib.add(image)
    image.update()

    if (datapath !== '') {
      ctx.api.setValue(ctx, datapath + '.image', image)
      image.lib_users++
    }

    this.outputs.image.setValue(image)
    bus.sendTrigger(ImageBus, 'flagRedraw')
  }
}

ToolOp.register(LoadImageOp)
