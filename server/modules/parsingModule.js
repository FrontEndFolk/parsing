const path = require('path');
const util = require('util');
const db = require('./db.js');
const iconv = require('iconv-lite');
const { spawn } = require('child_process');
const fetchAll = require('./sql.js');

// Наобещал за щёку
const runAsync = util.promisify(db.run.bind(db));
const getAsync = util.promisify(db.get.bind(db));
const allAsync = util.promisify(db.all.bind(db));

class ParsingModule {
    callPython(scriptName, input) {
        return new Promise((resolve, reject) => {
            const scriptPath = path.join(__dirname, '..', 'python_scripts', scriptName);
            const pythonPath = path.join(__dirname, '..', '.venv', 'Scripts', 'python.exe');

            const py = spawn(pythonPath, [scriptPath, input], {
                env: {
                    ...process.env,
                    PYTHONIOENCODING: 'utf-8'
                }
            });

            let stdoutData = '';
            let stderrData = '';

            py.stdout.on('data', (data) => {
                stdoutData += iconv.decode(data, 'utf-8');
            });

            py.stderr.on('data', (data) => {
                stderrData += iconv.decode(data, 'utf-8');
            });

            py.on('close', (code) => {
                if (code !== 0) {
                    console.error('Python stderr:', stderrData);
                    return reject(new Error(`Python exited with code ${code}`));
                }

                const jsonMatch = stdoutData.match(/{[\s\S]*}/);
                if (!jsonMatch) {
                    return reject(new Error("Не удалось найти JSON в выводе"));
                }
                
                try {
                    const json = JSON.parse(jsonMatch[0]);
                    resolve(json);
                } catch (e) {
                    console.error('Ошибка JSON:', e);
                    reject(e);
                }
            });
        });
    }

    async parse(url, marketplace) {
        const script = marketplace === 'OZON' ? 'parse_ozon.py' : 'parse_wb.py';
        try {
            return await this.callPython(script, url);
        } catch (err) {
            return null;
        }
    }

    async parseAll(products) {
        const results = [];

        for (const { article, marketplace } of products) {
            const data = await module.exports.parse(article, marketplace);
            if (data) {
                results.push({ article, marketplace, ...data });
            } else {
                console.warn(`Пропущен товар ${marketplace}:${article} — не удалось получить данные`);
            }
        }
        return results;
    }

    async saveToDatabase(productsData) {
        for (const data of productsData) {
            const { article, marketplace } = data;

            const existing = await getAsync(
                'SELECT id, price, sale_price FROM products WHERE article = ? AND marketplace = ?',
                [article, marketplace]
            );

            if (existing) {
                await runAsync(`
                    UPDATE products
                    SET 
                        name = ?,
                        price_old = price,
                        sale_price_old = sale_price,
                        price = ?,
                        sale_price = ?,
                        total_stock = ?
                    WHERE id = ?
                `, [
                    data.name,
                    data.price,
                    data.sale_price,
                    data.total_quantity,
                    existing.id
                ]);

                const productId = existing.id;

                await runAsync('DELETE FROM sizes WHERE product_id = ?', [productId]);

                for (const size of data.sizes) {
                    await runAsync(
                        'INSERT INTO sizes (product_id, size, stock) VALUES (?, ?, ?)',
                        [productId, size.size, size.stock]
                    );
                }

            } else {
                const insertProductStmt = await new Promise((resolve, reject) => {
                    db.run(`
                        INSERT INTO products (
                            article, marketplace, name, price, sale_price, price_old, sale_price_old, total_stock
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    `, [
                        article,
                        marketplace,
                        data.name,
                        data.price,
                        data.sale_price,
                        null,
                        null,
                        data.total_quantity
                    ], function (err) {
                        if (err) return reject(err);
                        resolve(this);
                    });
                });

                const productId = insertProductStmt.lastID;

                for (const size of data.sizes) {
                    await runAsync(
                        'INSERT INTO sizes (product_id, size, stock) VALUES (?, ?, ?)',
                        [productId, size.size, size.stock]
                    );
                }
            }
            console.log(`Обработан товар: ${marketplace}:${article}`);
        }
    }

    cronTest() {
        console.log('function called via cron job');
    }
}

module.exports = new ParsingModule();
