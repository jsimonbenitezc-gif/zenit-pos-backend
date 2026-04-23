require('dotenv').config();
const { Sequelize } = require('sequelize');

let sequelize;

if (process.env.NODE_ENV === 'test') {
    // Tests: SQLite en memoria (sin necesidad de PostgreSQL)
    sequelize = new Sequelize({
        dialect: 'sqlite',
        storage: ':memory:',
        logging: false,
    });
} else {
    sequelize = new Sequelize(
        process.env.DB_NAME,
        process.env.DB_USER,
        process.env.DB_PASSWORD,
        {
            host: process.env.DB_HOST,
            port: process.env.DB_PORT,
            dialect: 'postgres',
            logging: process.env.NODE_ENV === 'development' ? console.log : false,
            pool: {
                max: 20,
                min: 2,
                acquire: 30000,
                idle: 10000
            }
        }
    );

    // Test connection
    sequelize.authenticate()
        .then(() => {
            console.log('✅ Database connected successfully');
        })
        .catch(err => {
            console.error('❌ Unable to connect to database:', err);
        });
}

module.exports = sequelize;