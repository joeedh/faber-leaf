import {ResourceType, resourceManager} from './resource'

export const ImageExtensions = {
  png : 'image/png',
  jpg : 'image/jpeg',
  tiff: 'image/tiff',
  svg : 'image/svg',
  gif : 'image/gif',
}

class ImageResource extends ResourceType {
  image: HTMLImageElement | undefined
  ready: boolean

  constructor(url: string) {
    super(url)

    this.image = undefined
    this.ready = false
  }

  static handlesURL(url: string) {
    if (url.search(/data:image/) >= 0) return true

    url = url.toLowerCase()
    for (let k in ImageExtensions) {
      k = '\\.' + k

      if (url.search(k) >= 0) {
        return true
      }
    }

    return false
  }

  static createFromURL(url: string) {
    return new ImageResource(url)
  }

  static resourceDefine() {
    return {
      name  : 'image',
      uiName: 'Image',
    }
  }

  clone() {
    const ret = new ImageResource(this.url)
    ret.image = this.image
    return ret
  }

  load() {
    if (this.ready) {
      return
    }

    this.image = new Image()
    this.image.src = this.url
    this.image.onload = (e) => {
      this.ready = true
      this.fire('load', this.image)
    }
  }

  unload() {
    if (this.ready) {
      const image = this.image

      this.ready = false
      this.image = undefined

      this.fire('unload', image)
    }
  }

  isReady() {
    return this.ready
  }

  getThumbnail() {
    //returns an Image, or undefined
    return undefined
  }
}

resourceManager.register(ImageResource)
