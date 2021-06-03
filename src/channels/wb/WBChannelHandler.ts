import { Channel } from '../../models/channels'
import { ChannelHandler } from '../ChannelHandler'
import fetch from 'node-fetch'
import NodeCache = require('node-cache');

export class WBChannelHandler extends ChannelHandler {
    private cache = new NodeCache();

    public async processChannel(channel: Channel): Promise<void> {
    }

    public async getCategories(channel: Channel): Promise<{ id: string; name: string; }[]> {
        let data = this.cache.get('categories')
        if (! data) {
            const res = await fetch('https://content-suppliers.wildberries.ru/ns/characteristics-configurator-api/content-configurator/api/v1/config/get/object/all?top=10000&lang=ru')
            const json = await res.json()
            data = Object.values(json.data).map(value => { return {id: this.transliterate((<string>value).toLowerCase()), name: value} } )
            this.cache.set('categories', data, 3600)
        }
        return <{ id: string; name: string; }[]>data
    }
    
    private a:any = {"\"":"_","'":"_"," ": "_","Ё":"YO","Й":"I","Ц":"TS","У":"U","К":"K","Е":"E","Н":"N","Г":"G","Ш":"SH","Щ":"SCH","З":"Z","Х":"H","Ъ":"'","ё":"yo","й":"i","ц":"ts","у":"u","к":"k","е":"e","н":"n","г":"g","ш":"sh","щ":"sch","з":"z","х":"h","ъ":"'","Ф":"F","Ы":"I","В":"V","А":"a","П":"P","Р":"R","О":"O","Л":"L","Д":"D","Ж":"ZH","Э":"E","ф":"f","ы":"i","в":"v","а":"a","п":"p","р":"r","о":"o","л":"l","д":"d","ж":"zh","э":"e","Я":"Ya","Ч":"CH","С":"S","М":"M","И":"I","Т":"T","Ь":"'","Б":"B","Ю":"YU","я":"ya","ч":"ch","с":"s","м":"m","и":"i","т":"t","ь":"_","б":"b","ю":"yu"};
    private transliterate (word: string) {
      return word.split('').map( (char) => { 
        return this.a[char] || char; 
      }).join("")
    }
}