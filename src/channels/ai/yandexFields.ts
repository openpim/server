// Trusted general fields supported by the Yandex export mapping. Keep IDs in sync with web3/src/channels/yandex/index.js.
export const yandexGeneralFields = [
    {
        "id": "vendor",
        "name": "Название бренда или производителя. (Text)",
        "required": true,
        "description": "Название бренда или производителя. Должно быть записано так, как его пишет сам бренд.",
        "type": "TEXT",
        "aiMappingScope": "general"
    },
    {
        "id": "pictures",
        "name": "Ссылки на изображения товара. (Text[])",
        "required": true,
        "description": "Ссылки на изображения товара. Изображение по первой ссылке считается основным, остальные дополнительными.",
        "type": "TEXT_ARRAY",
        "aiMappingScope": "general"
    },
    {
        "id": "name",
        "name": "Наименование. (Text)",
        "required": true,
        "description": "Составляйте название по схеме: тип + бренд или производитель + модель + особенности, если есть (например, цвет, размер или вес) и количество в упаковке. Не включайте в название условия продажи (например, «скидка», «бесплатная доставка» и т. д.), эмоциональные характеристики («хит», «супер» и т. д.). Не пишите слова большими буквами — кроме устоявшихся названий брендов и моделей.",
        "type": "TEXT",
        "aiMappingScope": "general"
    },
    {
        "id": "description",
        "name": "Подробное описание товара: например, его преимущества и особенности. (Text)",
        "required": true,
        "description": "Не давайте в описании инструкций по установке и сборке. Не используйте слова «скидка», «распродажа», «дешевый», «подарок» (кроме подарочных категорий), «бесплатно», «акция», «специальная цена», «новинка», «new», «аналог», «заказ», «хит». Не указывайте никакой контактной информации и не давайте ссылок.",
        "type": "TEXT",
        "aiMappingScope": "general"
    },
    {
        "id": "additionalExpenses",
        "name": "Дополнительные расходы на товар. (Object: BasePriceDTO)",
        "required": false,
        "description": "Дополнительные расходы на товар. Например, на доставку или упаковку.",
        "type": "OBJECT",
        "aiMappingScope": "general"
    },
    {
        "id": "adult",
        "name": "Пометка 18+. (Boolean)",
        "required": false,
        "description": "Если товар не предназначен для детей младше определенного возраста, укажите это.",
        "type": "BOOLEAN",
        "aiMappingScope": "general"
    },
    {
        "id": "age",
        "name": "Возрастное ограничение. (Object: AgeDTO)",
        "required": false,
        "description": "Если товар не предназначен для детей младше определенного возраста, укажите это.",
        "type": "OBJECT",
        "aiMappingScope": "general"
    },
    {
        "id": "barcodes",
        "name": "Штрихкод товара от производителя. (Текст[])",
        "required": false,
        "description": "Указывайте в виде последовательности цифр. Подойдут коды EAN-13, EAN-8, UPC-A, UPC-E или Code 128. Для книг указывайте ISBN. Для товаров определенных категорий и торговых марок штрихкод должен быть действительным кодом GTIN. Обратите внимание: внутренние штрихкоды, начинающиеся на 2 или 02, и коды формата Code 128 не являются GTIN.",
        "type": "TEXT_ARRAY",
        "aiMappingScope": "general"
    },
    {
        "id": "basicPrice",
        "name": "Цена. (Object: UpdatePriceWithDiscountDTO)",
        "required": false,
        "description": "Цена на товар.",
        "type": "OBJECT",
        "aiMappingScope": "general"
    },
    {
        "id": "boxCount",
        "name": "Количество грузовых мест. (Number<int32>)",
        "required": false,
        "description": "Параметр используется, если товар представляет собой несколько коробок, упаковок и так далее. Например, кондиционер занимает два места — внешний и внутренний блоки в двух коробках. Для товаров, занимающих одно место, не передавайте этот параметр.",
        "type": "INTEGER",
        "aiMappingScope": "general"
    },
    {
        "id": "certificates",
        "name": "Номера документов на товар: сертификата, декларации соответствия и т. п. (Text[])",
        "required": false,
        "description": "Номера документов на товар: сертификата, декларации соответствия и т. п. Передавать можно только номера документов, сканы которого загружены в кабинете продавца по инструкции. ",
        "type": "TEXT_ARRAY",
        "aiMappingScope": "general"
    },
    {
        "id": "cofinancePrice",
        "name": "Цена для скидок с Маркетом. (Object: BasePriceDTO)",
        "required": false,
        "description": "Цена для скидок с Маркетом. Маркет может компенсировать до половины скидки. Назначьте минимальную цену до вычета тарифов, по которой готовы продавать товар, а мы рассчитаем скидку и размер софинансирования. Если Маркет не готов софинансировать скидку, покупатель ее не увидит.",
        "type": "OBJECT",
        "aiMappingScope": "general"
    },
    {
        "id": "commodityCodes",
        "name": "Товарные коды. (Object: CommodityCodeDTO[])",
        "required": false,
        "description": "Товарные коды.",
        "type": "OBJECT_ARRAY",
        "aiMappingScope": "general"
    },
    {
        "id": "condition",
        "name": "Состояние уцененного товара. (Object: OfferConditionDTO)",
        "required": false,
        "description": "Состояние уцененного товара. Используется только для товаров, продаваемых с уценкой.",
        "type": "OBJECT",
        "aiMappingScope": "general"
    },
    {
        "id": "downloadable",
        "name": "Признак цифрового товара. (Boolean)",
        "required": false,
        "description": "Признак цифрового товара. Укажите true, если товар доставляется по электронной почте.",
        "type": "BOOLEAN",
        "aiMappingScope": "general"
    },
    {
        "id": "firstVideoAsCover",
        "name": "Использовать первое видео в карточке как видеообложку. (Boolean)",
        "required": false,
        "description": "Передайте true, чтобы первое видео использовалось как видеообложка, или false, чтобы видеообложка не отображалась в карточке товара.",
        "type": "BOOLEAN",
        "aiMappingScope": "general"
    },
    {
        "id": "guaranteePeriod",
        "name": "Гарантийный срок. (Object: TimePeriodDTO)",
        "required": false,
        "description": "Гарантийный срок — период, в течение которого можно бесплатно заменить или починить товар. Обязательно указывайте срок, если он есть.",
        "type": "OBJECT",
        "aiMappingScope": "general"
    },
    {
        "id": "lifeTime",
        "name": "Срок службы. (Object: TimePeriodDTO)",
        "required": false,
        "description": "Срок службы — период, в течение которого товар должен исправно выполнять свою функцию. Обязательно указывайте срок, если он есть.",
        "type": "OBJECT",
        "aiMappingScope": "general"
    },
    {
        "id": "manuals",
        "name": "Список инструкций по использованию товара. (Object: OfferManualDTO[])",
        "required": false,
        "description": "Список инструкций по использованию товара.Максимальное количество инструкций — 6. Если вы передадите пустое поле manuals, загруженные ранее инструкции удалятся.",
        "type": "OBJECT_ARRAY",
        "aiMappingScope": "general"
    },
    {
        "id": "manufacturerCountries",
        "name": "Страна, где был произведен товар. (Text[])",
        "required": false,
        "description": "Страна, где был произведен товар. Записывайте названия стран так, как они записаны в списке. ",
        "type": "TEXT_ARRAY",
        "aiMappingScope": "general"
    },
    {
        "id": "purchasePrice",
        "name": "Себестоимость. (Object: BasePriceDTO)",
        "required": false,
        "description": "Себестоимость — затраты на самостоятельное производство товара или закупку у производителя или поставщиков.",
        "type": "OBJECT",
        "aiMappingScope": "general"
    },
    {
        "id": "shelfLife",
        "name": "Срок годности. (Object: TimePeriodDTO)",
        "required": false,
        "description": "Срок годности — период, по прошествии которого товар становится непригоден. Указывайте срок, указанный на банке или упаковке. Текущая дата, дата поставки или дата отгрузки значения не имеет. Обязательно указывайте срок, если он есть.",
        "type": "OBJECT",
        "aiMappingScope": "general"
    },
    {
        "id": "tags",
        "name": "Метки товара. (Text[])",
        "required": false,
        "description": "Метки товара, используемые магазином. Покупателям теги не видны. По тегам можно группировать и фильтровать разные товары в каталоге — например, товары одной серии, коллекции или линейки. Максимальная длина тега 20 символов. У одного товара может быть максимум 10 тегов. Всего можно создать не больше 50 разных тегов. ",
        "type": "TEXT_ARRAY",
        "aiMappingScope": "general"
    },
    {
        "id": "type",
        "name": "Особый тип товара. (Object: OfferType)",
        "required": false,
        "description": "Особый тип товара. Указывается, если товар: имеет особый тип, который хотите убрать; лекарство; бумажная или электронная книга; аудиокнига; музыка или видео; изготовляется на заказ; алкоголь.",
        "type": "OBJECT",
        "aiMappingScope": "general"
    },
    {
        "id": "vendorCode",
        "name": "Артикул товара от производителя. (Text)",
        "required": false,
        "description": "Артикул товара от производителя.",
        "type": "TEXT",
        "aiMappingScope": "general"
    },
    {
        "id": "videos",
        "name": "Ссылка (URL) на видео товара. (Text[])",
        "required": false,
        "description": "Ссылка (URL) на видео товара. Максимальное количество ссылок — 6. Требования к ссылке: Указывайте ссылку целиком, включая протокол http или https. Максимальная длина — 512 символов. Русские буквы в URL можно. Можно использовать прямые ссылки на видео и на Яндекс Диск. Ссылки на Яндекс Диске нужно копировать с помощью функции Поделиться. Относительные ссылки и ссылки на другие облачные хранилища — не работают.",
        "type": "TEXT_ARRAY",
        "aiMappingScope": "general"
    },
    {
        "id": "weightDimensions",
        "name": "Габариты упаковки и вес товара. (Object: OfferWeightDimensionsDTO)",
        "required": false,
        "description": "Габариты упаковки и вес товара.",
        "type": "OBJECT",
        "aiMappingScope": "general"
    }
]
