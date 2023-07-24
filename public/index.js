const ctx1 = document.getElementById('myChart1').getContext('2d');
const ctx2 = document.getElementById('myChart2').getContext('2d');
const ctx3 = document.getElementById('myChart2').getContext('2d');

const config1 = {
    type: 'line',
    data: {
        datasets: [
            {
                label: 'Speed (MB/s)',
                backgroundColor: 'rgba(255, 99, 132, 0.5)',
                borderColor: 'rgb(255, 99, 132)',
                fill: false,
                data: [],
                yAxisID: 'y',
            },
            {
                label: 'Concurrent Threads (n)',
                backgroundColor: 'rgba(54, 162, 235, 0.5)',
                borderColor: 'rgb(54, 162, 235)',
                fill: true,
                data: [],
                yAxisID: 'y1',
            },
            {
                label: 'Log size (MB)',
                backgroundColor: 'rgba(235,129,54,0.5)',
                borderColor: 'rgb(253,153,12)',
                fill: true,
                data: [],
                yAxisID: 'y2',
            }
        ]
    },
    options: {
        responsive: true,
        interaction: {
            mode: 'index',
            intersect: false,
        },
        stacked: false,
        plugins: {
            title: {
                display: true,
                text: 'Dynamo Logger Performance'
            }
        },
        scales: {
            y: {
                type: 'linear',
                display: true,
                position: 'left',
                min: 0
            },
            y1: {
                type: 'linear',
                display: true,
                position: 'right',
                min: 1,
                max: 16
            },
            y2: {
                type: 'linear',
                display: true,
                position: 'right',
                min: 0
            },
            x: {
                type: 'realtime',
                realtime: {
                    delay: 2000,
                    onRefresh: chart => {

                        $.ajax({
                            url: '/plugins/dynamo-signalk-logger-plugin/info',
                            success: function (data) {

                                for (let i = 0; i<100; i++) {
                                    myChart2.data.datasets[0].data[i] = data["speed"]["buffer"][i]["speed"]/1000000
                                    myChart2.data.datasets[1].data[i] = data["speed"]["buffer"][i]["threads"]
                                }
                                myChart2.update();


                                myChart3.data.datasets[0].data[0] = data["queue"]["concurrency"]
                                myChart3.data.datasets[1].data[0] = data["queue"]["pending"]
                                myChart3.data.datasets[2].data[0] = data["queue"]["upload"]
                                myChart3.data.datasets[3].data[0] = data["queue"]["processing"]

                                myChart3.update();

                                let latestSpeed=(data["speed"]["latest"])/1000000
                                if (data["status"]["text"] === "error") {
                                    latestSpeed = 0
                                }

                                chart.data.datasets.forEach(function (dataset,idx) {
                                    switch (idx) {
                                        case 0:
                                            dataset.data.push({
                                                x: Date.now(),
                                                y: latestSpeed
                                            });
                                            break
                                        case 1:
                                            dataset.data.push({
                                                x: Date.now(),
                                                y: data["queue"]["concurrency"]
                                            });
                                            break
                                        case 2:
                                            dataset.data.push({
                                                x: Date.now(),
                                                y: data["logfile"]["size"]/1000000
                                            });
                                            break
                                    }

                                });
                            }
                        })
                    }
                }
            }
        }
    }
};

const labels2 =Array.from(Array(100).keys());
const data2 = {
    labels: labels2,
    datasets: [{
        label: 'Speed (MB/s)',
        data: [],
        yAxisID: 'y',
        backgroundColor: [
            'rgba(255, 99, 132, 0.2)'
        ],
        borderColor: [
            'rgb(255, 99, 132)'
        ],
        borderWidth: 1
    },
        {
            label: 'Concurrent Threads (n)',
            data: [],
            yAxisID: 'y1',
            backgroundColor: [
                'rgba(54, 162, 235, 0.2)'
            ],
            borderColor: [
                'rgb(54, 162, 235)'
            ],
            borderWidth: 1
        }]
};

const config2 = {
    type: 'bar',
    data: data2,
    options: {
        scales: {
            y: {
                type: 'linear',
                display: true,
                position: 'left',
                min: 0
            },
            y1: {
                type: 'linear',
                display: true,
                position: 'right',
                min: 1,
                max: 16,

                // grid line settings
                grid: {
                    drawOnChartArea: false, // only want the grid lines for one axis to show up
                },
            },
        }
    },
};

const data3 = {
    labels: ["Queue"],
    datasets: [
        {
            label: 'Concurrency',
            data: [],
            backgroundColor: 'rgba(54, 162, 235, 0.2)',
            borderColor: 'rgb(54, 162, 235)',
            borderWidth: 1
        },
        {
            label: 'Pending',
            data: [],
            backgroundColor: 'rgba(54,63,235,0.2)',
            borderColor: 'rgb(20,45,225)',
            borderWidth: 1
        },
        {
            label: 'Upload',
            data: [],
            backgroundColor: 'rgba(99,54,235,0.2)',
            borderColor: 'rgb(105,54,235)',
            borderWidth: 1
        },
        {
            label: 'Processing',
            data: [],
            backgroundColor: 'rgba(255, 99, 132, 0.2)',
            borderColor: 'rgb(255, 99, 132)',
            borderWidth: 1
        }
    ]
};

const config3 = {
    type: 'bar',
    data: data3,
    options: {
        scales: {
            y: {
                type: 'linear',
                display: true,
                position: 'left',
                ticks: {
                    stepSize: 1
                },
                min: 0
            }
        }
    },
};

const myChart1 = new Chart(
    document.getElementById('myChart1'),
    config1
);

const myChart2 = new Chart(
    document.getElementById('myChart2'),
    config2
);

const myChart3 = new Chart(
    document.getElementById('myChart3'),
    config3
);

$.ajax({
    url: '/plugins/dynamo-signalk-logger-plugin/publickey',
    dataType: 'json',
    success: function(data){
        $('#publickey').append('<code>' + data.publickey + '</code>');
    }
});
