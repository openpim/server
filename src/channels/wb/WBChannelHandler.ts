import { Channel } from '../../models/channels'
import { ChannelAttribute, ChannelCategory, ChannelHandler } from '../ChannelHandler'
import fetch from 'node-fetch'
import NodeCache = require('node-cache');

export class WBChannelHandler extends ChannelHandler {
    private cache = new NodeCache();

    public async processChannel(channel: Channel): Promise<void> {
    }

    public async getCategories(channel: Channel): Promise<ChannelCategory[]> {
        let data = this.cache.get('categories')
        if (! data) {
            const res = await fetch('https://content-suppliers.wildberries.ru/ns/characteristics-configurator-api/content-configurator/api/v1/config/get/object/all?top=10000&lang=ru')
            const json = await res.json()
            data = Object.values(json.data).map(value => { return {id: this.transliterate((<string>value).toLowerCase()), name: value} } )
            this.cache.set('categories', data, 3600)
        }
        return <ChannelCategory[]>data
    }
    
    public async getAttributes(channel: Channel, categoryId: string): Promise<ChannelAttribute[]> {
        let data = this.cache.get('attr_'+categoryId)
        if (! data) {
            const categories = await this.getCategories(channel)
            const category = categories.find(elem => elem.id === categoryId)

            if (!category) throw new Error('Failed to find category by id: ' + categoryId)

            const res = await fetch('https://content-suppliers.wildberries.ru/ns/characteristics-configurator-api/content-configurator/api/v1/config/get/object/translated?name=' + encodeURIComponent(category.name) + '&lang=ru')
            const json = await res.json()
            data = Object.values(json.data.addin).map((addin:any) => { 
                return { 
                    id: this.transliterate((<string>addin.type).toLowerCase()), 
                    name: addin.type + (addin.units ? ' (' + addin.units[0] + ')' : ''),
                    required: addin.required,
                    dictionary: !!addin.dictionary,
                    dictionaryLink: addin.dictionary ? 'https://content-suppliers.wildberries.ru/ns/characteristics-configurator-api/content-configurator/api/v1/directory/' + encodeURIComponent(addin.dictionary.substring(1)) + '?lang=ru&top=500' : null
                } 
            } )

            if (json.data.nomenclature && json.data.nomenclature.addin) {
                const nomenclature = json.data.nomenclature.addin.map((addin:any) => { 
                    return { 
                        id: this.transliterate((<string>addin.type).toLowerCase()), 
                        name: addin.type + (addin.units ? ' (' + addin.units[0] + ')' : ''),
                        required: addin.required,
                        dictionary: !!addin.dictionary,
                        dictionaryLink: addin.dictionary ? 'https://content-suppliers.wildberries.ru/ns/characteristics-configurator-api/content-configurator/api/v1/directory/' + encodeURIComponent(addin.dictionary.substring(1)) + '?lang=ru&top=500' : null
                    } 
                } )
                data = [...<ChannelAttribute[]>data, ...nomenclature]
            }
            this.cache.set('attr_'+categoryId, data, 3600)
        }
        return <ChannelAttribute[]>data
    }

    private a:any = {"(": "_", ")": "_", "\"":"_","'":"_"," ": "_","Ё":"YO","Й":"I","Ц":"TS","У":"U","К":"K","Е":"E","Н":"N","Г":"G","Ш":"SH","Щ":"SCH","З":"Z","Х":"H","Ъ":"'","ё":"yo","й":"i","ц":"ts","у":"u","к":"k","е":"e","н":"n","г":"g","ш":"sh","щ":"sch","з":"z","х":"h","ъ":"'","Ф":"F","Ы":"I","В":"V","А":"a","П":"P","Р":"R","О":"O","Л":"L","Д":"D","Ж":"ZH","Э":"E","ф":"f","ы":"i","в":"v","а":"a","п":"p","р":"r","о":"o","л":"l","д":"d","ж":"zh","э":"e","Я":"Ya","Ч":"CH","С":"S","М":"M","И":"I","Т":"T","Ь":"'","Б":"B","Ю":"YU","я":"ya","ч":"ch","с":"s","м":"m","и":"i","т":"t","ь":"_","б":"b","ю":"yu"};
    private transliterate (word: string) {
      return word.split('').map( (char) => { 
        return this.a[char] || char; 
      }).join("")
    }
}